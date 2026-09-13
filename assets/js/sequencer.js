/*
 * Secuenciador: modelo de show, línea de tiempo y transporte.
 *
 * No toca el DOM y no mide el tiempo por su cuenta: quien lo usa le va dando
 * el reloj con `advance(nowMs)`. Así la misma lógica sirve para la interfaz
 * (con requestAnimationFrame) y para las pruebas en Node (con un reloj falso),
 * y el despacho es reproducible en lugar de depender de cuándo llegue un timer.
 *
 * El envío está detrás de la interfaz `transmitter`. Hoy solo existe el
 * emulado, que no transmite nada; conectar un dispositivo real consiste en
 * implementar `send()` y pasarlo al transporte, sin tocar el resto.
 */

const Sequencer = (() => {
  'use strict';

  /*
   * Un pulso corto no lleva tiempos: el badge aplica los suyos. La duración
   * que se dibuja es el destello que se ve, no la transmisión, que dura unos
   * pocos milisegundos.
   */
  const SHORT_PULSE_MS = 500;

  const DEFAULT_CHANNEL_COUNT = 3;

  let nextId = 1;
  const makeId = prefix => `${prefix}-${nextId++}`;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  // ------------------------------------------------------------- estructura

  function createClip({ at = 0, label = 'Comando', effect, transmission = {} }) {
    if (!effect || !effect.color) throw new Error('Un clip necesita un efecto con color');
    return {
      id: makeId('clip'),
      at: Math.max(0, Math.round(at)),
      label,
      effect: { mode: 'short', ...effect },
      transmission: { ...transmission },
    };
  }

  function createChannel({ name = 'Canal', clips = [], muted = false, solo = false } = {}) {
    return { id: makeId('ch'), name, muted, solo, clips: [...clips] };
  }

  function createShow({ name = 'Show sin título', channels } = {}) {
    return {
      name,
      channels:
        channels ||
        Array.from({ length: DEFAULT_CHANNEL_COUNT }, (_, i) =>
          createChannel({ name: `Canal ${i + 1}` }),
        ),
    };
  }

  /**
   * Duración visible de un clip. En modo configurable sale del envolvente; con
   * `gsten` el sostén no lo marca el campo sustain sino el sustain global del
   * dispositivo, así que se usa esa tabla.
   */
  function clipDurationMs(clip) {
    const e = clip.effect;
    if (e.mode !== 'configurable') return SHORT_PULSE_MS;
    const sustain = e.useGlobalSustain
      ? IRFrame.GST_MS[e.sustain || 0]
      : IRFrame.TIMER_MS[e.sustain || 0];
    return IRFrame.TIMER_MS[e.attack || 0] + sustain + IRFrame.TIMER_MS[e.release || 0];
  }

  function clipEndMs(clip) {
    return clip.at + clipDurationMs(clip);
  }

  function showDurationMs(show) {
    let end = 0;
    for (const channel of show.channels) {
      for (const clip of channel.clips) end = Math.max(end, clipEndMs(clip));
    }
    return end;
  }

  // --------------------------------------------------------------- edición

  function addClip(show, channelId, clip) {
    const channel = show.channels.find(c => c.id === channelId);
    if (!channel) throw new Error(`Canal desconocido: ${channelId}`);
    channel.clips.push(clip);
    sortChannel(channel);
    return clip;
  }

  function removeClip(show, clipId) {
    for (const channel of show.channels) {
      const index = channel.clips.findIndex(c => c.id === clipId);
      if (index >= 0) return channel.clips.splice(index, 1)[0];
    }
    return null;
  }

  function findClip(show, clipId) {
    for (const channel of show.channels) {
      const clip = channel.clips.find(c => c.id === clipId);
      if (clip) return { channel, clip };
    }
    return null;
  }

  function moveClip(show, clipId, at, channelId) {
    const found = findClip(show, clipId);
    if (!found) return null;
    const { channel, clip } = found;
    clip.at = Math.max(0, Math.round(at));
    if (channelId && channelId !== channel.id) {
      channel.clips.splice(channel.clips.indexOf(clip), 1);
      addClip(show, channelId, clip);
    } else {
      sortChannel(channel);
    }
    return clip;
  }

  const sortChannel = channel => channel.clips.sort((a, b) => a.at - b.at);

  /**
   * Un canal suena si no está silenciado y, cuando hay algún solo activo, si
   * es uno de los que están en solo. Es la convención de cualquier secuenciador
   * y evita tener que silenciar el resto a mano.
   */
  function channelAudible(show, channel) {
    const anySolo = show.channels.some(c => c.solo);
    if (anySolo) return channel.solo && !channel.muted;
    return !channel.muted;
  }

  /** Todos los clips que deben sonar, en orden cronológico. */
  function timeline(show) {
    const events = [];
    for (const channel of show.channels) {
      if (!channelAudible(show, channel)) continue;
      for (const clip of channel.clips) {
        events.push({ at: clip.at, channelId: channel.id, channelName: channel.name, clip });
      }
    }
    return events.sort((a, b) => a.at - b.at || a.channelId.localeCompare(b.channelId));
  }

  // ----------------------------------------------------------- transmisores

  /**
   * Emulación: codifica la trama de verdad —para que lo que se ve sea lo que
   * se enviaría— pero no la transmite a ningún sitio.
   */
  function createEmulatedTransmitter() {
    return {
      id: 'emulado',
      name: 'Emulación local',
      transmits: false,
      send(event) {
        const frame = IRFrame.encodeEffect(event.clip.effect, event.clip.transmission);
        return { ok: true, frame, detail: 'emulado, sin transmisión' };
      },
    };
  }

  // -------------------------------------------------------------- transporte

  /**
   * Reloj del show. `advance(nowMs)` despacha lo que haya vencido desde la
   * última llamada; recibir el tiempo desde fuera es lo que lo hace probable
   * sin navegador y lo que evita que un frame perdido se salte un clip.
   */
  function createTransport({ show, transmitter, onDispatch, onState } = {}) {
    let playing = false;
    let cursor = 0;        // posición del cabezal, en ms
    let lastNow = null;    // última marca de reloj recibida
    let loop = false;
    let events = [];
    let index = 0;

    const state = () => ({ playing, cursor, loop, duration: showDurationMs(show) });
    const emit = () => onState && onState(state());

    /*
     * Recalcula la lista de eventos y la reposiciona en el cursor.
     *
     * `inclusive` decide qué pasa con un clip que cae justo en el cursor. Al
     * arrancar o tras un seek debe sonar, porque aún no ha sonado; si el show
     * cambia mientras suena, no, o se repetiría el que se acaba de despachar.
     */
    function rebuild(inclusive = true) {
      events = timeline(show);
      index = events.findIndex(event => (inclusive ? event.at >= cursor : event.at > cursor));
      if (index < 0) index = events.length;
    }

    function dispatchUntil(time) {
      while (index < events.length && events[index].at <= time) {
        const event = events[index++];
        let result;
        try {
          result = transmitter.send(event);
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        if (onDispatch) onDispatch({ ...event, result, transmitter: transmitter.name });
      }
    }

    return {
      state,

      play() {
        if (playing) return;
        playing = true;
        lastNow = null;
        rebuild();
        emit();
      },

      pause() {
        playing = false;
        lastNow = null;
        emit();
      },

      stop() {
        playing = false;
        lastNow = null;
        cursor = 0;
        rebuild();
        emit();
      },

      seek(ms) {
        cursor = Math.max(0, Math.round(ms));
        rebuild();
        emit();
      },

      setLoop(value) {
        loop = Boolean(value);
        emit();
      },

      /** Avisa de que el show cambió mientras estaba parado o sonando. */
      invalidate() {
        rebuild(!playing);
        emit();
      },

      setTransmitter(next) {
        transmitter = next;
        emit();
      },

      /**
       * Llamar en cada frame con un reloj monótono. Devuelve el estado nuevo.
       * El primer aviso tras play() solo fija la referencia: sin eso, el hueco
       * entre pulsar play y el primer frame se despacharía de golpe.
       */
      advance(nowMs) {
        if (!playing) return state();
        if (lastNow === null) {
          lastNow = nowMs;
          dispatchUntil(cursor);
          return state();
        }
        const delta = Math.max(0, nowMs - lastNow);
        lastNow = nowMs;
        cursor += delta;

        const duration = showDurationMs(show);
        dispatchUntil(cursor);

        if (cursor >= duration + 250) {
          if (loop && duration > 0) {
            cursor = 0;
            rebuild();
          } else {
            playing = false;
            cursor = duration;
          }
          emit();
        }
        return state();
      },
    };
  }

  // ------------------------------------------------------- serialización

  /** El show como objeto plano, para descargarlo o volver a cargarlo. */
  function toJSON(show) {
    return {
      format: 'ir-frame-show',
      version: 1,
      name: show.name,
      durationMs: showDurationMs(show),
      channels: show.channels.map(channel => ({
        name: channel.name,
        muted: channel.muted,
        solo: channel.solo,
        clips: channel.clips.map(clip => ({
          at: clip.at,
          durationMs: clipDurationMs(clip),
          label: clip.label,
          effect: clip.effect,
          transmission: clip.transmission,
        })),
      })),
    };
  }

  function fromJSON(data) {
    if (!data || data.format !== 'ir-frame-show') {
      throw new Error('No parece un show de esta herramienta');
    }
    return createShow({
      name: data.name || 'Show importado',
      channels: (data.channels || []).map(channel =>
        createChannel({
          name: channel.name,
          muted: Boolean(channel.muted),
          solo: Boolean(channel.solo),
          clips: (channel.clips || []).map(clip =>
            createClip({
              at: clip.at,
              label: clip.label,
              effect: clip.effect,
              transmission: clip.transmission,
            }),
          ),
        }),
      ),
    });
  }

  /** Las entradas que esperan los exportadores, en orden cronológico. */
  function toExportEntries(show) {
    return timeline(show).map(event => ({
      name: event.clip.label,
      note: `${event.channelName} · ${(event.at / 1000).toFixed(2)} s`,
      result: IRFrame.encodeEffect(event.clip.effect, event.clip.transmission),
    }));
  }

  return {
    SHORT_PULSE_MS,
    clamp,
    createShow,
    createChannel,
    createClip,
    clipDurationMs,
    clipEndMs,
    showDurationMs,
    addClip,
    removeClip,
    findClip,
    moveClip,
    channelAudible,
    timeline,
    createEmulatedTransmitter,
    createTransport,
    toJSON,
    fromJSON,
    toExportEntries,
  };
})();
