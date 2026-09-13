/*
 * Secuenciador: modelo de show, línea de tiempo y transporte.
 *
 * No toca el DOM y no mide el tiempo por su cuenta: quien lo usa le va dando
 * el reloj con `advance(nowMs)`. Así la misma lógica sirve para la interfaz
 * (con requestAnimationFrame) y para las pruebas en Node (con un reloj falso),
 * y el despacho es reproducible en lugar de depender de cuándo llegue un timer.
 *
 * El envío está detrás de la interfaz `transmitter`: el emulado, que codifica
 * pero no transmite, y el de dispositivo por HTTP. Añadir otro transporte
 * físico consiste en implementar `send()` y pasarlo al transporte, sin tocar el
 * resto.
 */

const Sequencer = (() => {
  'use strict';

  /*
   * Un pulso corto no lleva tiempos: el badge aplica los suyos. La duración
   * que se dibuja es el destello que se ve, no la transmisión, que dura unos
   * pocos milisegundos.
   */
  const SHORT_PULSE_MS = 500;

  /*
   * Los canales no son una invención de esta herramienta: son los grupos del
   * protocolo, el campo `restrict group id` de 5 bits. El grupo 0 es difusión
   * —lo ejecuta cualquier dispositivo, sea cual sea su grupo— y del 1 al 31
   * solo lo ejecutan los badges cuyo grupo coincide.
   *
   * Por eso el primer canal es siempre el de difusión y no se puede ni borrar
   * ni cambiar de grupo, y por eso no caben más de 32 canales.
   */
  const BROADCAST_GROUP = 0;
  const MAX_GROUP = 31;
  const MAX_CHANNELS = MAX_GROUP + 1;

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

  function createChannel({ name, group = 0, clips = [], muted = false, solo = false } = {}) {
    const id = makeId('ch');
    const safeGroup = clamp(Math.round(group) || 0, BROADCAST_GROUP, MAX_GROUP);
    return {
      id,
      name: name || defaultChannelName(safeGroup),
      group: safeGroup,
      muted,
      solo,
      clips: [...clips],
    };
  }

  const defaultChannelName = group =>
    group === BROADCAST_GROUP ? 'Difusión (todos)' : `Grupo ${group}`;

  function createShow({ name = 'Show sin título', channels } = {}) {
    return {
      name,
      channels:
        channels ||
        Array.from({ length: DEFAULT_CHANNEL_COUNT }, (_, i) => createChannel({ group: i })),
    };
  }

  /** El primer canal siempre es el de difusión: ni se borra ni cambia de grupo. */
  const isBroadcastChannel = (show, channel) => show.channels[0] === channel;

  /** Primer grupo libre, para que «+ Canal» no repita ninguno. */
  function nextFreeGroup(show) {
    const used = new Set(show.channels.map(c => c.group));
    for (let group = 1; group <= MAX_GROUP; group++) {
      if (!used.has(group)) return group;
    }
    return null;
  }

  function addChannel(show, options = {}) {
    if (show.channels.length >= MAX_CHANNELS) {
      throw new Error(`No caben más de ${MAX_CHANNELS} canales: el grupo son 5 bits`);
    }
    const group = options.group == null ? nextFreeGroup(show) : options.group;
    if (group == null) throw new Error('No quedan grupos libres');
    const channel = createChannel({ ...options, group });
    show.channels.push(channel);
    return channel;
  }

  function removeChannel(show, channelId) {
    const index = show.channels.findIndex(c => c.id === channelId);
    if (index < 0) return null;
    if (index === 0) throw new Error('El canal de difusión no se puede eliminar');
    return show.channels.splice(index, 1)[0];
  }

  /**
   * Cambia el grupo de un canal. Dos canales con el mismo grupo emitirían lo
   * mismo a los mismos badges sin que se note por qué, así que se rechaza.
   */
  function setChannelGroup(show, channelId, group) {
    const channel = show.channels.find(c => c.id === channelId);
    if (!channel) throw new Error(`Canal desconocido: ${channelId}`);
    if (isBroadcastChannel(show, channel)) {
      throw new Error('El canal de difusión es siempre el grupo 0');
    }
    const value = Math.round(Number(group));
    if (!Number.isFinite(value) || value < 1 || value > MAX_GROUP) {
      throw new Error(`El grupo debe estar entre 1 y ${MAX_GROUP}`);
    }
    const taken = show.channels.find(c => c !== channel && c.group === value);
    if (taken) throw new Error(`El grupo ${value} ya lo usa «${taken.name}»`);

    const renombrar = channel.name === defaultChannelName(channel.group);
    channel.group = value;
    if (renombrar) channel.name = defaultChannelName(value);
    return channel;
  }

  /**
   * El efecto tal y como se codifica. El grupo lo manda el canal y no el clip:
   * mover un clip de canal cambia a quién va dirigido, que es justo lo que se
   * espera de una pista.
   */
  function effectFor(channel, clip) {
    return {
      ...clip.effect,
      restrictGroupId: channel.group,
      /*
       * Los campos que dependen de la memoria del aparato van apagados a la
       * fuerza: `gsten` toma el sostén de lo que el badge lleve guardado, y
       * `onStart` y `repeatEnabled` lo escriben. Un show tiene que sonar igual
       * en cualquier badge, así que no salen de aquí ni aunque vengan en una
       * sesión antigua.
       */
      useGlobalSustain: false,
      onStart: false,
      repeatEnabled: false,
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

  /**
   * Intensidad de 0 a 1 a los `elapsedMs` de haberse disparado el clip: rampa
   * de ataque, sostén plano, rampa de relajación y 0 fuera. Es lo que permite
   * previsualizar lo que haría el badge en vez de enseñar un parpadeo.
   *
   * La previsualización es APROXIMADA, y hay dos casos documentados que no se
   * pueden reproducir con fidelidad porque el dispositivo los resuelve con su
   * propio estado interno: `sustain = 111` con `release` distinto de cero, y
   * `release = 000`. Aquí se tratan como el resto —tabla de tiempos y rampa
   * lineal— sabiendo que el badge real puede alargar o cortar el final.
   *
   * El pulso corto no lleva tiempos en la trama: el badge aplica los suyos, así
   * que se dibuja encendido durante el destello y no se inventa una envolvente.
   */
  function clipIntensityAt(clip, elapsedMs) {
    if (elapsedMs < 0) return 0;
    const e = clip.effect;

    if (e.mode !== 'configurable') {
      return elapsedMs < SHORT_PULSE_MS ? 1 : 0;
    }

    const attack = IRFrame.TIMER_MS[e.attack || 0];
    const sustain = e.useGlobalSustain
      ? IRFrame.GST_MS[e.sustain || 0]
      : IRFrame.TIMER_MS[e.sustain || 0];
    const release = IRFrame.TIMER_MS[e.release || 0];

    if (elapsedMs < attack) return elapsedMs / attack;
    if (elapsedMs < attack + sustain) return 1;

    const inRelease = elapsedMs - attack - sustain;
    if (inRelease < release) return 1 - inRelease / release;
    return 0;
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
        events.push({
          at: clip.at,
          channelId: channel.id,
          channelName: channel.name,
          group: channel.group,
          effect: effectFor(channel, clip),
          clip,
        });
      }
    }
    return events.sort((a, b) => a.at - b.at || a.channelId.localeCompare(b.channelId));
  }

  // --------------------------------------------------------------- formas

  /*
   * Catálogo de formas de comando para montar shows. Viven aquí y no en
   * `presets.js` porque aquel es el catálogo del generador —comandos completos,
   * con su color— y esto es lo contrario: la envolvente sin color, que el
   * secuenciador combina con el que elija cada quien. Son datos, no DOM.
   *
   * Los índices son los de las tablas del protocolo: `IRFrame.TIMER_MS` para
   * ataque, sostén y relajación, y `IRFrame.CHANCE_PCT` para la probabilidad.
   */
  /*
   * Todas las formas son del comando configurable de 9 bytes: los tiempos
   * viajan en la trama y el resultado no depende de lo que el badge lleve
   * guardado. El comando corto de 6 bytes existe en el protocolo y lo ofrece la
   * pestaña del generador, pero aquí no: delega los tiempos en la configuración
   * del aparato, y un show tiene que sonar igual en todos.
   */
  const CLIP_SHAPES = Object.freeze([
    {
      id: 'pulso-largo',
      name: 'Pulso largo',
      effect: { mode: 'configurable', attack: 0, sustain: 5, release: 1, chance: 0 },
    },
    {
      id: 'destello',
      name: 'Destello',
      effect: { mode: 'configurable', attack: 0, sustain: 1, release: 1, chance: 0 },
    },
    {
      id: 'fundido-corto',
      name: 'Fundido corto',
      effect: { mode: 'configurable', attack: 2, sustain: 2, release: 2, chance: 0 },
    },
    {
      id: 'fundido-largo',
      name: 'Fundido largo',
      effect: { mode: 'configurable', attack: 5, sustain: 4, release: 5, chance: 0 },
    },
    {
      id: 'respiracion-lenta',
      name: 'Respiración lenta',
      effect: { mode: 'configurable', attack: 6, sustain: 3, release: 6, chance: 0 },
    },
    {
      id: 'subida-larga',
      name: 'Subida larga',
      /*
       * Relajación 1 y no 0 a propósito: con 0 el protocolo entra en un caso
       * especial sin documentar que además fija el color de fondo del aparato,
       * estado que sobrevive al comando. Una forma del catálogo no debe dejar
       * rastro en el dispositivo.
       */
      effect: { mode: 'configurable', attack: 7, sustain: 2, release: 1, chance: 0 },
    },
    {
      id: 'caida-larga',
      name: 'Caída larga',
      effect: { mode: 'configurable', attack: 0, sustain: 2, release: 7, chance: 0 },
    },
    {
      id: 'disperso-suave',
      name: 'Disperso suave (32 %)',
      effect: { mode: 'configurable', attack: 3, sustain: 4, release: 3, chance: 4 },
    },
    {
      id: 'chispas',
      name: 'Chispas (10 %)',
      effect: { mode: 'configurable', attack: 0, sustain: 1, release: 1, chance: 6 },
    },
  ]);

  /** La forma cuyos valores coinciden con el efecto, si es que hay alguna. */
  function matchShape(effect) {
    return (
      CLIP_SHAPES.find(shape =>
        Object.entries(shape.effect).every(([key, value]) => (effect[key] || 0) === (value || 0)),
      ) || null
    );
  }

  // ---------------------------------------------------------- distribución

  /*
   * Repartir un clip cada pocos milisegundos durante minutos genera miles de
   * nodos y deja la pestaña inservible, así que hay tope y se avisa al llegar.
   */
  const MAX_DISTRIBUTE_COPIES = 256;

  /**
   * Copia un clip a lo largo de su canal cada `everyMs` hasta `untilMs`.
   * Devuelve las copias creadas y, si se quedó corto, el motivo.
   */
  function distributeClip(show, clipId, { everyMs, untilMs } = {}) {
    const found = findClip(show, clipId);
    if (!found) throw new Error('El clip ya no existe');

    const step = Math.round(Number(everyMs));
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error('El intervalo tiene que ser mayor que cero');
    }
    const limit = Math.round(Number(untilMs));
    if (!Number.isFinite(limit)) throw new Error('El límite no es un tiempo válido');

    const { channel, clip } = found;
    const copies = [];
    let capped = false;

    for (let at = clip.at + step; at <= limit; at += step) {
      if (copies.length >= MAX_DISTRIBUTE_COPIES) {
        capped = true;
        break;
      }
      copies.push(
        createClip({
          at,
          label: clip.label,
          effect: clip.effect,
          transmission: clip.transmission,
        }),
      );
    }

    for (const copy of copies) addClip(show, channel.id, copy);

    return {
      copies,
      capped,
      reason: capped
        ? `se alcanzó el tope de ${MAX_DISTRIBUTE_COPIES} copias`
        : copies.length
          ? null
          : 'el límite no deja sitio para ninguna copia',
    };
  }

  // ----------------------------------------------------------- transmisores

  /*
   * Un evento de la línea de tiempo ya trae el efecto con su grupo; un clip
   * suelto —una prueba, una llamada directa— se codifica tal cual.
   */
  const eventEffect = event => event.effect || event.clip.effect;

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
        const frame = IRFrame.encodeEffect(eventEffect(event), event.clip.transmission);
        return { ok: true, frame, detail: 'emulado, sin transmisión' };
      },
    };
  }

  /*
   * Dispositivo real por HTTP. Vive aquí, sin DOM y con `fetch` inyectable,
   * para poder probarlo en Node con un doble: emitir infrarrojos de verdad no
   * es algo que deba pasar en una suite automática.
   *
   * Límites del firmware: el cuerpo es `pronto=<trama>` en
   * application/x-www-form-urlencoded con los espacios como %20, entre 16 y 320
   * caracteres y como mucho 64 words. Se comprueban antes de enviar para que un
   * rechazo previsible se explique en el registro y no como un 400 opaco.
   */
  const DEVICE_MIN_CHARS = 16;
  const DEVICE_MAX_CHARS = 320;
  const DEVICE_MAX_WORDS = 64;

  function createDeviceTransmitter({
    baseUrl = 'http://led-badge.local',
    fetchImpl,
    onResult,
  } = {}) {
    const fetcher = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const root = String(baseUrl).trim().replace(/\/+$/, '');

    async function request(path, init) {
      if (!fetcher) throw new Error('Este entorno no tiene fetch');
      return fetcher(`${root}${path}`, init);
    }

    /** Mensaje de error del firmware, que responde {"error":"..."} en los 400. */
    async function reasonFrom(response) {
      try {
        const body = await response.json();
        if (body && body.error) return String(body.error);
      } catch {
        /* una respuesta sin JSON no aporta más que su código */
      }
      return `respuesta ${response.status}`;
    }

    return {
      id: 'dispositivo',
      name: 'Dispositivo por HTTP',
      transmits: true,
      baseUrl: root,

      /**
       * Pregunta por el estado del dispositivo. Es diagnóstico, no emisión:
       * sirve para distinguir «no responde» de «responde pero rechaza la trama».
       */
      async test() {
        try {
          const response = await request('/api/state', { method: 'GET' });
          if (!response.ok) {
            return { ok: false, error: `el dispositivo respondió ${response.status}` };
          }
          return { ok: true, detail: `responde en ${root}` };
        } catch (error) {
          return { ok: false, error: error.message || 'no responde' };
        }
      },

      /*
       * El despacho del transporte es síncrono a propósito: un frame no puede
       * quedarse esperando una respuesta HTTP o el resto de clips del show
       * llegarían tarde. Así que esto dispara la petición y devuelve ya, con
       * `settled` para quien quiera enterarse del desenlace —la interfaz lo usa
       * para corregir la línea del registro cuando llega la respuesta—.
       */
      send(event) {
        const frame = IRFrame.encodeEffect(eventEffect(event), event.clip.transmission);
        const pronto = frame.pronto;
        const words = pronto.split(' ').length;

        if (pronto.length < DEVICE_MIN_CHARS || pronto.length > DEVICE_MAX_CHARS) {
          return {
            ok: false,
            frame,
            error:
              `la trama mide ${pronto.length} caracteres y el dispositivo ` +
              `acepta de ${DEVICE_MIN_CHARS} a ${DEVICE_MAX_CHARS}`,
          };
        }
        if (words > DEVICE_MAX_WORDS) {
          return {
            ok: false,
            frame,
            error: `la trama tiene ${words} words y el dispositivo acepta ${DEVICE_MAX_WORDS}`,
          };
        }

        const settled = request('/api/raw', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'rest-client',
          },
          body: `pronto=${encodeURIComponent(pronto)}`,
        })
          .then(async response => {
            if (!response.ok) return { ok: false, error: await reasonFrom(response) };
            return { ok: true, detail: 'aceptada por el dispositivo' };
          })
          .catch(error => ({
            ok: false,
            error: error.message || 'no se pudo contactar con el dispositivo',
          }))
          .then(result => {
            if (onResult) onResult({ event, frame, ...result });
            return result;
          });

        return { ok: true, frame, pending: true, detail: 'enviada, esperando respuesta', settled };
      },
    };
  }

  // ------------------------------------------------------------------ audio

  /**
   * Picos (mínimo y máximo) de cada columna de píxel de una forma de onda.
   *
   * Es cálculo puro sobre las muestras, así que vive en el modelo y no en el
   * canvas: dibujar es solo recorrer el resultado. Con menos muestras que
   * columnas cada columna coge al menos una muestra, para no devolver huecos.
   */
  function audioPeaks(samples, columns) {
    const count = Math.max(1, Math.floor(columns));
    const total = samples ? samples.length : 0;
    const peaks = new Array(count);
    if (!total) {
      for (let i = 0; i < count; i++) peaks[i] = { min: 0, max: 0 };
      return peaks;
    }

    const perColumn = total / count;
    for (let i = 0; i < count; i++) {
      const start = Math.min(total - 1, Math.floor(i * perColumn));
      const end = Math.min(total, Math.max(start + 1, Math.floor((i + 1) * perColumn)));
      let min = samples[start];
      let max = samples[start];
      for (let s = start + 1; s < end; s++) {
        const value = samples[s];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      peaks[i] = { min, max };
    }
    return peaks;
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
        /*
         * Al terminar, el cabezal se queda clavado en el final. Pulsar
         * reproducir ahí no hacía nada visible —no queda show por delante—, así
         * que se rebobina solo: es lo que se espera de un botón de play.
         */
        const duration = showDurationMs(show);
        if (duration > 0 && cursor >= duration) cursor = 0;
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

      /**
       * Devuelve el cabezal al principio sin tocar la reproducción: si sonaba,
       * sigue sonando desde cero; si estaba parado, se queda parado en cero.
       */
      rewind() {
        cursor = 0;
        lastNow = null;
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
       * Fija el cabezal en un tiempo absoluto del show. Es lo que hace falta
       * cuando el reloj no lo pone el navegador sino una pista de audio: ahí
       * el dato natural no es «cuánto ha pasado» sino «por dónde va la
       * canción», y calcular deltas contra un reloj ajeno acumularía deriva en
       * cuanto el audio se resincronice solo.
       *
       * No se re-despacha lo ya despachado porque el índice de eventos solo
       * avanza; un salto hacia atrás (bucle del audio o búsqueda) sí rearma la
       * lista, porque a partir de ahí lo que venga aún no ha sonado.
       */
      syncTo(positionMs) {
        const next = Math.max(0, Math.round(positionMs));
        const back = next < cursor;
        cursor = next;
        // Si luego se vuelve al reloj monótono, que se reancle en vez de
        // despachar de golpe todo el hueco.
        lastNow = null;
        if (back || !playing) rebuild();
        else dispatchUntil(cursor);
        emit();
        return state();
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
      format: SHOW_FORMAT,
      // La versión 2 añade el grupo del protocolo a cada canal.
      version: SHOW_VERSION,
      name: show.name,
      durationMs: showDurationMs(show),
      channels: show.channels.map(channel => ({
        name: channel.name,
        group: channel.group,
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

  const SHOW_FORMAT = 'ir-frame-show';
  const SHOW_VERSION = 2;

  /*
   * Se valida todo antes de construir nada: quien llama reemplaza su show con
   * lo que devuelve esta función, así que un archivo a medias tiene que fallar
   * entero y no dejar la mitad cargada.
   */
  function fromJSON(data) {
    if (!data || typeof data !== 'object' || data.format !== SHOW_FORMAT) {
      throw new Error('No parece un show de esta herramienta');
    }
    if (data.version != null && !(data.version >= 1 && data.version <= SHOW_VERSION)) {
      throw new Error(`Formato de show versión ${data.version}, desconocido para esta versión`);
    }
    if (!Array.isArray(data.channels)) throw new Error('El archivo no trae canales');
    if (data.channels.length > MAX_CHANNELS) {
      throw new Error(`El archivo trae ${data.channels.length} canales y el tope es ${MAX_CHANNELS}`);
    }

    const channels = data.channels.map((channel, index) => {
      if (!channel || typeof channel !== 'object') {
        throw new Error(`El canal ${index + 1} no es válido`);
      }
      // Un show de la versión 1 no traía grupos: el primer canal era el que
      // llegaba a todos, así que se reparten por orden.
      const group = channel.group == null ? Math.min(index, MAX_GROUP) : Number(channel.group);
      if (!Number.isInteger(group) || group < BROADCAST_GROUP || group > MAX_GROUP) {
        throw new Error(`El canal ${index + 1} trae un grupo fuera de rango: ${channel.group}`);
      }
      const clips = channel.clips == null ? [] : channel.clips;
      if (!Array.isArray(clips)) throw new Error(`Los clips del canal ${index + 1} no son una lista`);

      return createChannel({
        name: channel.name,
        group,
        muted: Boolean(channel.muted),
        solo: Boolean(channel.solo),
        clips: clips.map((clip, position) => {
          if (!clip || typeof clip !== 'object' || !Number.isFinite(Number(clip.at))) {
            throw new Error(`El clip ${position + 1} del canal ${index + 1} no tiene tiempo válido`);
          }
          if (!clip.effect || typeof clip.effect !== 'object' || !clip.effect.color) {
            throw new Error(`El clip ${position + 1} del canal ${index + 1} no trae color`);
          }
          return createClip({
            at: Number(clip.at),
            label: clip.label,
            effect: clip.effect,
            transmission: clip.transmission,
          });
        }),
      });
    });

    return createShow({ name: data.name || 'Show importado', channels });
  }

  // -------------------------------------------------------------- sesiones

  /*
   * Sesiones guardadas en el almacenamiento del navegador. Lo que se guarda es
   * exactamente el formato de «Guardar show» (`toJSON`/`fromJSON`), así que
   * vale lo mismo para un archivo que para una sesión y la validación es la
   * misma en los dos caminos.
   *
   * El almacenamiento se inyecta para poder probar esto en Node con un doble:
   * aquí no hay `localStorage` ni DOM.
   *
   * La pista de audio NO se guarda: es un `File` que el navegador solo entrega
   * tras elegirlo en el diálogo de archivos, y además el principio del proyecto
   * es que la música no sale del navegador ni se copia a ningún sitio. Se anota
   * solo su nombre para poder decir cuál era y que se vuelva a seleccionar.
   */
  const SESSION_KEY = 'ir-frame.sesiones';
  const SESSION_STORE_VERSION = 1;

  const isQuotaError = error =>
    Boolean(error) &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014);

  const countClips = data =>
    (data && Array.isArray(data.channels) ? data.channels : []).reduce(
      (total, channel) => total + ((channel && channel.clips) || []).length,
      0,
    );

  function createSessionStore({ storage, now = () => Date.now(), key = SESSION_KEY } = {}) {
    /*
     * Toda lectura va envuelta: en modo privado o con el almacenamiento
     * bloqueado, `getItem` puede lanzar. Si algo falla se devuelve una lista
     * vacía, que es lo mismo que no tener sesiones: la página funciona igual.
     */
    function readAll() {
      try {
        const raw = storage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== SESSION_STORE_VERSION) return [];
        if (!Array.isArray(parsed.sessions)) return [];
        return parsed.sessions.filter(
          entry => entry && typeof entry === 'object' && entry.id && entry.show,
        );
      } catch {
        return [];
      }
    }

    function writeAll(sessions) {
      try {
        storage.setItem(key, JSON.stringify({ version: SESSION_STORE_VERSION, sessions }));
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: isQuotaError(error)
            ? 'no cabe en el almacenamiento del navegador: elimina alguna sesión'
            : `el navegador no dejó guardar: ${error.message || error}`,
        };
      }
    }

    /** Metadatos, de la más reciente a la más antigua. */
    function list() {
      return readAll()
        .map(entry => ({
          id: entry.id,
          name: entry.name || (entry.show && entry.show.name) || 'Sesión',
          updatedAt: entry.updatedAt || 0,
          audioName: entry.audioName || null,
          clips: countClips(entry.show),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const latest = () => list()[0] || null;

    /**
     * Devuelve la sesión ya convertida en show. Si está corrupta o es de un
     * formato que no se entiende, se descarta y se avisa: arrancar en blanco es
     * mejor que arrancar roto, pero no en silencio.
     */
    function load(id) {
      const entry = readAll().find(item => item.id === id);
      if (!entry) return { ok: false, error: 'esa sesión ya no está guardada' };
      try {
        return {
          ok: true,
          session: {
            id: entry.id,
            name: entry.name || 'Sesión',
            updatedAt: entry.updatedAt || 0,
            audioName: entry.audioName || null,
            view: entry.view && typeof entry.view === 'object' ? entry.view : {},
            show: fromJSON(entry.show),
          },
        };
      } catch (error) {
        remove(id);
        return { ok: false, discarded: true, error: error.message };
      }
    }

    function save({ id, name, show, view = {}, audioName = null }) {
      const sessions = readAll();
      const sessionId = id || `sesion-${now()}-${Math.floor(Math.random() * 1e6)}`;
      const entry = {
        id: sessionId,
        name: name || show.name || 'Sesión',
        updatedAt: now(),
        audioName,
        view,
        show: toJSON(show),
      };
      const index = sessions.findIndex(item => item.id === sessionId);
      if (index >= 0) sessions[index] = entry;
      else sessions.push(entry);

      const result = writeAll(sessions);
      return { ...result, id: sessionId };
    }

    function rename(id, name) {
      const sessions = readAll();
      const entry = sessions.find(item => item.id === id);
      if (!entry) return { ok: false, error: 'esa sesión ya no está guardada' };
      entry.name = String(name || '').trim() || entry.name;
      return { ...writeAll(sessions), id };
    }

    function remove(id) {
      const sessions = readAll().filter(item => item.id !== id);
      return writeAll(sessions);
    }

    return { list, latest, load, save, rename, remove };
  }

  /** Las entradas que esperan los exportadores, en orden cronológico. */
  function toExportEntries(show) {
    return timeline(show).map(event => ({
      name: event.clip.label,
      note:
        `${event.channelName} · ${(event.at / 1000).toFixed(2)} s · ` +
        (event.group === BROADCAST_GROUP ? 'difusión (grupo 0)' : `grupo ${event.group}`),
      result: IRFrame.encodeEffect(event.effect, event.clip.transmission),
    }));
  }

  return {
    SHORT_PULSE_MS,
    clamp,
    BROADCAST_GROUP,
    MAX_GROUP,
    MAX_CHANNELS,
    createShow,
    createChannel,
    createClip,
    addChannel,
    removeChannel,
    setChannelGroup,
    isBroadcastChannel,
    nextFreeGroup,
    effectFor,
    SHOW_FORMAT,
    SHOW_VERSION,
    CLIP_SHAPES,
    matchShape,
    MAX_DISTRIBUTE_COPIES,
    distributeClip,
    clipDurationMs,
    clipEndMs,
    clipIntensityAt,
    showDurationMs,
    addClip,
    removeClip,
    findClip,
    moveClip,
    channelAudible,
    timeline,
    createEmulatedTransmitter,
    createDeviceTransmitter,
    DEVICE_MAX_WORDS,
    audioPeaks,
    createTransport,
    toJSON,
    fromJSON,
    SESSION_KEY,
    SESSION_STORE_VERSION,
    createSessionStore,
    toExportEntries,
  };
})();
