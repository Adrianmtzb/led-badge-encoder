/*
 * Interfaz del secuenciador. Todo el DOM de la pestaña vive aquí; la lógica de
 * show, línea de tiempo y transporte está en sequencer.js, sin DOM.
 *
 * El reloj sale de requestAnimationFrame y se le pasa al transporte, que es
 * quien decide qué despachar. La interfaz solo pinta lo que el modelo dice.
 */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const root = $('panel-secuenciador');
  if (!root) return;

  const bridge = window.GeneratorBridge || {
    currentCommand: () => ({
      label: 'Comando',
      effect: { color: { r: 240, g: 80, b: 0 }, mode: 'configurable' },
      transmission: {},
    }),
    toast: () => {},
  };

  // ----------------------------------------------------------------- estado

  const view = {
    pxPerSecond: 90,
    snapMs: 100,
    // Pestaña abierta del conmutador de ajustes, recordada con la sesión.
    tab: 'sesion',
    // Registro de emisión desplegado, recordado también con la sesión.
    logOpen: true,
    selectedClipId: null,
    // Mientras se edita un clip, el control de color escribe sobre él.
    editingClipId: null,
    fullscreen: false,
    // Sin un mínimo, un show vacío no tendría dónde soltar el primer clip.
    minSpanMs: 12000,
  };

  /*
   * Comando propio de la pestaña. Antes el único origen era el generador, lo
   * que obligaba a cambiar de pestaña para cada color; el puente sigue estando
   * como atajo, pero ya no es la única vía.
   */
  /*
   * El secuenciador solo usa el comando configurable de 9 bytes: es el único
   * cuyo resultado no depende de lo que el badge lleve guardado en su memoria.
   * `useGlobalSustain`, `onStart` y `repeatEnabled` se quedan fuera por lo
   * mismo —toman o escriben estado persistente del aparato—, así que ni se
   * ofrecen ni se envían.
   */
  const command = {
    effect: {
      color: { r: 240, g: 80, b: 0 },
      mode: 'configurable',
      // Valores de «Fundido corto», para que el panel abra con un efecto del
      // catálogo y no con uno «a medida» que nadie ha elegido.
      attack: 2,
      sustain: 2,
      release: 2,
      chance: 0,
    },
    transmission: {},
  };

  const show = Sequencer.createShow({ name: 'Show sin título' });

  const DEVICE_URL_KEY = 'ir-frame.dispositivo.url';

  function storedDeviceUrl() {
    try {
      return localStorage.getItem(DEVICE_URL_KEY) || 'http://led-badge.local';
    } catch {
      // Un navegador con el almacenamiento bloqueado no debe romper la pestaña.
      return 'http://led-badge.local';
    }
  }

  const transmitters = {
    emulado: Sequencer.createEmulatedTransmitter(),
    dispositivo: Sequencer.createDeviceTransmitter({
      baseUrl: storedDeviceUrl(),
      onResult: settleLogRow,
    }),
  };
  let transmitter = transmitters.emulado;

  const transport = Sequencer.createTransport({
    show,
    transmitter,
    onDispatch: handleDispatch,
    onState: renderTransportState,
  });

  // -------------------------------------------------------------- utilidades

  const msToPx = ms => (ms / 1000) * view.pxPerSecond;
  const pxToMs = px => (px / view.pxPerSecond) * 1000;

  const snap = ms =>
    view.snapMs > 0 ? Math.round(ms / view.snapMs) * view.snapMs : Math.round(ms);

  const cssColor = ({ r, g, b }) => `rgb(${r} ${g} ${b})`;

  const toHex = ({ r, g, b }) =>
    `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

  function parseHex(text) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(text).trim());
    if (!match) return null;
    const value = parseInt(match[1], 16);
    return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
  }

  function formatTime(ms) {
    const total = Math.max(0, ms);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = Math.floor(total % 1000);
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  /** Ancho útil de la línea de tiempo: el show más un margen para seguir añadiendo. */
  const spanMs = () =>
    Math.max(view.minSpanMs, Sequencer.showDurationMs(show) + 4000, audio.durationMs + 2000);

  /*
   * El texto sobre un clip tiene que leerse tanto en un amarillo como en un
   * azul marino, así que se elige por luminancia relativa en vez de fijar uno.
   */
  function readableInk({ r, g, b }) {
    const channel = v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return luminance > 0.42 ? '#101318' : '#ffffff';
  }

  // ------------------------------------------------------------------ nodos

  const heads = $('seq-heads');
  const lanes = $('seq-lanes');
  const ruler = $('seq-ruler');
  const playhead = $('seq-playhead');
  const scroll = $('seq-scroll');
  const logList = $('seq-log');
  const grid = root.querySelector('.seq-grid');
  const wave = $('seq-wave');
  const waveLane = $('seq-wavelane');
  const panel = $('seq-panel');

  // ------------------------------------------------------------------ audio

  /*
   * PRINCIPIO DEL PROYECTO: el archivo de música NUNCA se sube a ningún sitio.
   * Se lee con la API de archivos, se decodifica en memoria y se reproduce
   * desde una URL de objeto local; ni hay servidor al que mandarlo ni lo habrá.
   * Todo el cálculo de esta página ocurre en el navegador, y el audio también.
   */
  const audio = {
    element: null,
    objectUrl: null,
    samples: null,
    durationMs: 0,
    name: '',
  };

  // Los navegadores no dibujan un lienzo más ancho que unos 32 000 px, y con el
  // zoom al máximo una canción larga lo pasa de sobra.
  const MAX_WAVE_PX = 32000;

  /** Mezcla a mono: para ver los golpes no hace falta separar canales. */
  function toMono(buffer) {
    const length = buffer.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i];
    }
    if (buffer.numberOfChannels > 1) {
      for (let i = 0; i < length; i++) mono[i] /= buffer.numberOfChannels;
    }
    return mono;
  }

  function releaseAudio() {
    if (audio.element) {
      audio.element.pause();
      audio.element.removeAttribute('src');
    }
    if (audio.objectUrl) URL.revokeObjectURL(audio.objectUrl);
    audio.element = null;
    audio.objectUrl = null;
    audio.samples = null;
    audio.durationMs = 0;
    audio.name = '';
  }

  async function loadAudio(file) {
    releaseAudio();
    const bytes = await file.arrayBuffer();
    const context = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      // decodeAudioData se queda con el ArrayBuffer, así que se le da una copia.
      decoded = await context.decodeAudioData(bytes.slice(0));
    } finally {
      context.close();
    }

    audio.samples = toMono(decoded);
    audio.durationMs = Math.round(decoded.duration * 1000);
    audio.name = file.name;
    audio.objectUrl = URL.createObjectURL(file);

    const element = new Audio(audio.objectUrl);
    element.preload = 'auto';
    element.addEventListener('ended', () => {
      if (transport.state().loop) {
        element.currentTime = 0;
        element.play();
        transport.syncTo(0);
      } else {
        transport.pause();
      }
    });
    audio.element = element;
  }

  function drawWave() {
    if (!audio.samples) {
      waveLane.hidden = true;
      return;
    }
    waveLane.hidden = false;

    const width = Math.min(MAX_WAVE_PX, Math.round(msToPx(spanMs())));
    // El alto lo manda el carril, que es una fila más de la línea de tiempo.
    const height = Math.max(1, waveLane.clientHeight);
    const ratio = Math.min(2, window.devicePixelRatio || 1);

    wave.style.width = `${width}px`;
    wave.style.height = `${height}px`;
    wave.width = Math.round(width * ratio);
    wave.height = Math.round(height * ratio);

    const ctx = wave.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Solo se dibuja el tramo que ocupa la canción; el resto de la línea de
    // tiempo se queda limpio para que se note dónde acaba.
    const columns = Math.max(1, Math.min(width, Math.round(msToPx(audio.durationMs))));
    const peaks = Sequencer.audioPeaks(audio.samples, columns);
    const middle = height / 2;

    ctx.fillStyle = getComputedStyle(root).getPropertyValue('--text-mute').trim() || '#6b7481';
    for (let x = 0; x < columns; x++) {
      const top = middle - peaks[x].max * middle;
      const bottom = middle - peaks[x].min * middle;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }

  function renderAudioState() {
    $('seq-audio-clear').hidden = !audio.samples;
    const label = $('seq-audio-file').parentElement.querySelector('span');
    label.textContent = audio.samples
      ? `Pista: ${audio.name} (${formatTime(audio.durationMs)})`
      : 'Pista de audio';
  }

  /** Lleva el audio a donde esté el cabezal, sin pasarse de su duración. */
  function seekAudio(ms) {
    if (!audio.element) return;
    audio.element.currentTime = Math.min(Math.max(0, ms), audio.durationMs) / 1000;
  }

  // ------------------------------------------------------------------ regla

  function renderRuler() {
    const width = msToPx(spanMs());
    ruler.style.width = `${width}px`;
    lanes.style.width = `${width}px`;
    ruler.textContent = '';

    // Un paso fijo se vuelve ilegible al alejar el zoom, así que se elige el
    // primero que deje al menos 54 px entre marcas.
    const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
    const step = steps.find(s => msToPx(s) >= 54) || steps[steps.length - 1];

    for (let t = 0; t <= spanMs(); t += step) {
      const mark = el('div', 'seq-tick');
      mark.style.left = `${msToPx(t)}px`;
      mark.appendChild(el('span', null, t % 1000 === 0 ? `${t / 1000}s` : `${t}ms`));
      ruler.appendChild(mark);
    }
  }

  // ---------------------------------------------------------- confirmación

  /*
   * Confirmación propia en vez de `confirm()`: el diálogo del navegador no se
   * puede vestir con el tema y, en pantalla completa, saca al usuario de la
   * vista. Cancelar es siempre lo que ocurre por omisión —Escape, clic fuera y
   * el foco inicial van a «Cancelar»—, porque lo que se confirma destruye.
   */
  let confirmResolve = null;

  function askConfirm({ title, text, action = 'Eliminar' }) {
    return new Promise(resolve => {
      closeConfirm(false);
      confirmResolve = resolve;
      $('seq-confirm-title').textContent = title;
      $('seq-confirm-text').textContent = text;
      $('seq-confirm-ok').textContent = action;
      $('seq-confirm').hidden = false;
      requestAnimationFrame(() => $('seq-confirm-cancel').focus());
    });
  }

  function closeConfirm(value) {
    $('seq-confirm').hidden = true;
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(value);
  }

  const confirmOpen = () => !$('seq-confirm').hidden;

  // ----------------------------------------------------------------- pistas

  function renderChannels() {
    heads.textContent = '';
    lanes.textContent = '';

    // Alinea la primera pista con la regla, que ocupa su propia fila.
    heads.appendChild(el('div', 'seq-head-spacer'));

    // La onda es una fila más, así que necesita su cabecera para no desalinear.
    if (audio.samples) {
      const waveHead = el('div', 'seq-head-wave');
      waveHead.appendChild(el('strong', null, 'Audio'));
      heads.appendChild(waveHead);
    }

    const anySolo = show.channels.some(c => c.solo);

    for (const channel of show.channels) {
      const head = el('div', 'seq-head');
      if (!Sequencer.channelAudible(show, channel)) head.classList.add('is-silent');

      const meter = el('span', 'seq-meter');
      meter.dataset.meter = channel.id;
      head.appendChild(meter);

      const broadcast = Sequencer.isBroadcastChannel(show, channel);

      const identity = el('div', 'seq-head-id');

      const name = el('input', 'seq-name');
      name.value = channel.name;
      name.setAttribute('aria-label', `Nombre del canal ${channel.name}`);
      name.addEventListener('change', () => {
        channel.name = name.value.trim() || 'Canal';
        transport.invalidate();
        renderChannels();
      });
      identity.appendChild(name);

      /*
       * El grupo no es una etiqueta nuestra: es el `restrict group id` que va
       * en la trama. El 0 llega a todos los badges, así que ese canal se marca
       * y no se deja tocar.
       */
      if (broadcast) {
        const tag = el('span', 'seq-group is-broadcast', 'Difusión · grupo 0 · llega a todos');
        identity.appendChild(tag);
      } else {
        const group = el('input', 'seq-group-input');
        group.type = 'number';
        group.min = '1';
        group.max = String(Sequencer.MAX_GROUP);
        group.value = String(channel.group);
        group.setAttribute('aria-label', `Grupo del canal ${channel.name}`);
        group.title = `Grupo del protocolo (1 a ${Sequencer.MAX_GROUP})`;
        group.addEventListener('change', () => {
          try {
            Sequencer.setChannelGroup(show, channel.id, group.value);
          } catch (error) {
            bridge.toast(error.message);
          }
          transport.invalidate();
          renderAll();
        });
        const wrap = el('label', 'seq-group');
        wrap.appendChild(el('span', null, 'Grupo'));
        wrap.appendChild(group);
        identity.appendChild(wrap);
      }

      head.appendChild(identity);

      const buttons = el('div', 'seq-head-actions');

      const mute = el('button', 'seq-toggle', 'M');
      mute.type = 'button';
      mute.title = 'Silenciar canal';
      mute.setAttribute('aria-pressed', String(channel.muted));
      mute.addEventListener('click', () => {
        channel.muted = !channel.muted;
        transport.invalidate();
        renderChannels();
      });
      buttons.appendChild(mute);

      const solo = el('button', 'seq-toggle', 'S');
      solo.type = 'button';
      solo.title = 'Escuchar solo este canal';
      solo.setAttribute('aria-pressed', String(channel.solo));
      if (anySolo && channel.solo) solo.classList.add('is-on');
      solo.addEventListener('click', () => {
        channel.solo = !channel.solo;
        transport.invalidate();
        renderChannels();
      });
      buttons.appendChild(solo);

      if (!broadcast) {
        const remove = el('button', 'seq-toggle', '×');
        remove.type = 'button';
        remove.title = 'Eliminar canal';
        remove.addEventListener('click', async () => {
          /*
           * Un canal se lleva por delante todos sus clips, así que se pregunta
           * con la cuenta delante. Vacío no hay nada que perder: se borra y ya.
           */
          if (channel.clips.length) {
            const ok = await askConfirm({
              title: `Eliminar «${channel.name}»`,
              text:
                (channel.clips.length === 1
                  ? 'Se perderá su único clip.'
                  : `Se perderán sus ${channel.clips.length} clips.`) +
                ' Esto no se puede deshacer.',
              action: 'Eliminar canal',
            });
            if (!ok) {
              remove.focus();
              return;
            }
          }
          try {
            Sequencer.removeChannel(show, channel.id);
          } catch (error) {
            bridge.toast(error.message);
            return;
          }
          if (view.editingClipId && !Sequencer.findClip(show, view.editingClipId)) closePanel();
          transport.invalidate();
          renderAll();
        });
        buttons.appendChild(remove);
      }

      head.appendChild(buttons);
      if (channel.muted) mute.classList.add('is-on');
      heads.appendChild(head);

      lanes.appendChild(buildLane(channel));
    }

    // 32 canales es el tope: el grupo del protocolo son 5 bits.
    $('seq-add-channel').disabled = show.channels.length >= Sequencer.MAX_CHANNELS;

    // Por aquí pasa todo cambio del show —clips, canales, zoom—, así que es el
    // sitio natural para pedir el autoguardado sin sembrar llamadas por todas partes.
    markDirty();
  }

  function buildLane(channel) {
    const lane = el('div', 'seq-lane');
    lane.dataset.channel = channel.id;
    if (!Sequencer.channelAudible(show, channel)) lane.classList.add('is-silent');

    lane.addEventListener('pointerdown', event => {
      if (event.target !== lane) return;
      const at = snap(pxToMs(event.offsetX));
      addCurrentCommand(channel.id, at);
    });

    for (const clip of channel.clips) lane.appendChild(buildClip(channel, clip));
    return lane;
  }

  /*
   * El generador nombra sus comandos como "rgb(240,80,0)", que no cabe en un
   * clip de medio segundo. En la pista se muestra el hexadecimal, que ocupa la
   * mitad; el nombre completo sigue estando en el panel del clip y en las
   * descargas.
   */
  function compactLabel(label, color) {
    if (!/^rgb\(/i.test(label)) return label;
    const hex = v => v.toString(16).padStart(2, '0').toUpperCase();
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  }

  /*
   * Silueta de lo que el comando NO enciende, en porcentajes del clip. Se
   * muestrea `clipIntensityAt` —la misma función que mueve los indicadores— en
   * unos pocos puntos: bastan para que se reconozca la forma de un vistazo.
   */
  const ENV_MIN_PX = 26;

  function envelopePolygon(clip, widthPx) {
    if (widthPx < ENV_MIN_PX) return null;
    const duration = Sequencer.clipDurationMs(clip);
    if (!duration) return null;
    // Un pulso corto está encendido de principio a fin: no hay silueta que pintar.
    if (clip.effect.mode !== 'configurable') return null;

    const steps = Math.min(24, Math.max(8, Math.round(widthPx / 6)));
    const points = ['0% 0%', '100% 0%'];
    for (let i = steps; i >= 0; i--) {
      const x = (i / steps) * 100;
      const level = Sequencer.clipIntensityAt(clip, (i / steps) * duration);
      points.push(`${x.toFixed(1)}% ${((1 - level) * 100).toFixed(1)}%`);
    }
    return `polygon(${points.join(', ')})`;
  }

  function buildClip(channel, clip) {
    const node = el('button', 'seq-clip');
    node.type = 'button';
    node.dataset.clip = clip.id;
    node.style.left = `${msToPx(clip.at)}px`;
    node.style.width = `${Math.max(14, msToPx(Sequencer.clipDurationMs(clip)))}px`;

    const quantized = IRFrame.quantizeColor(clip.effect.color);
    node.style.background = cssColor(quantized);
    node.style.color = readableInk(quantized);
    if (clip.id === view.selectedClipId) node.classList.add('is-selected');

    const width = Math.max(14, msToPx(Sequencer.clipDurationMs(clip)));
    const envelope = envelopePolygon(clip, width);
    if (envelope) {
      const shade = el('span', 'seq-clip-env');
      shade.style.clipPath = envelope;
      node.appendChild(shade);
    }

    node.appendChild(el('span', 'seq-clip-label', compactLabel(clip.label, quantized)));
    node.setAttribute(
      'aria-label',
      `${clip.label} en ${channel.name}, ${formatTime(clip.at)}. ` +
        'Púlsalo para abrir sus ajustes, arrástralo para moverlo, ' +
        'Suprimir para eliminarlo.',
    );

    /*
     * El botón derecho elimina. Es destructivo y fácil de disparar sin querer,
     * así que en vez de un diálogo —que rompería el ritmo de montaje— se puede
     * deshacer desde el aviso o con Ctrl/Cmd+Z.
     */
    node.addEventListener('contextmenu', event => {
      event.preventDefault();
      deleteClip(clip.id);
    });

    attachDrag(node, channel, clip);
    return node;
  }

  // --------------------------------------------------------------- arrastre

  /** El carril que hay a esa altura de pantalla, o el más cercano. */
  function laneAt(clientY) {
    const all = [...lanes.children];
    if (!all.length) return null;
    for (const lane of all) {
      const rect = lane.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return lane;
    }
    return clientY < all[0].getBoundingClientRect().top ? all[0] : all[all.length - 1];
  }

  function markDropLane(lane) {
    for (const other of lanes.querySelectorAll('.seq-lane.is-drop')) {
      if (other !== lane) other.classList.remove('is-drop');
    }
    if (lane) lane.classList.add('is-drop');
  }

  function attachDrag(node, channel, clip) {
    let dragging = false;
    let moved = false;
    let grabOffsetPx = 0;
    // Canal de destino mientras dura el arrastre: cambiarlo cambia el grupo.
    let targetChannelId = channel.id;

    node.addEventListener('pointerdown', event => {
      event.stopPropagation();
      dragging = true;
      moved = false;
      targetChannelId = channel.id;
      grabOffsetPx = event.clientX - node.getBoundingClientRect().left;
      node.setPointerCapture(event.pointerId);
      select(clip.id);
    });

    node.addEventListener('pointermove', event => {
      if (!dragging) return;
      const laneRect = node.parentElement.getBoundingClientRect();
      const left = event.clientX - laneRect.left - grabOffsetPx;
      const at = snap(Math.max(0, pxToMs(left)));

      /*
       * El clip no se muda de carril hasta soltar: moverlo en el DOM en pleno
       * arrastre le quitaría la captura del puntero. Hasta entonces se resalta
       * el carril donde va a caer.
       */
      const lane = laneAt(event.clientY);
      const nextChannel = lane ? lane.dataset.channel : channel.id;
      if (nextChannel !== targetChannelId) {
        targetChannelId = nextChannel;
        moved = true;
      }
      markDropLane(targetChannelId === channel.id ? null : lane);

      if (at !== clip.at) {
        moved = true;
        clip.at = at;
        node.style.left = `${msToPx(at)}px`;
        if (view.editingClipId === clip.id) renderPanelFields();
        placePanel();
      }
    });

    const end = event => {
      if (!dragging) return;
      dragging = false;
      markDropLane(null);
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      if (moved) {
        Sequencer.moveClip(show, clip.id, clip.at, targetChannelId);
        transport.invalidate();
        renderTimeline();
        if (view.editingClipId === clip.id) openPanel(clip.id);
      } else {
        // Un clic limpio sobre el clip abre su panel: es el mismo gesto que el
        // botón derecho, para no tener dos comportamientos que aprender.
        openPanel(clip.id);
      }
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    /*
     * El navegador puede quitar la captura por su cuenta —un menú del sistema,
     * el puntero saliendo de la ventana—: sin esto el arrastre se quedaría a
     * medias y el clip volvería a su canal sin que se entendiera por qué.
     */
    node.addEventListener('lostpointercapture', end);
  }

  // ------------------------------------------------------------- selección

  function select(clipId) {
    view.selectedClipId = clipId;
    for (const node of lanes.querySelectorAll('.seq-clip')) {
      node.classList.toggle('is-selected', node.dataset.clip === clipId);
    }
  }

  // --------------------------------------------------- panel flotante del clip

  const envelopeSelects = ['seq-attack', 'seq-sustain', 'seq-release'];

  function fillShapeOptions() {
    const select = $('seq-shape');
    select.textContent = '';
    /*
     * «A medida» no se elige: es lo que queda marcado cuando se tocan los
     * tiempos a mano y el resultado ya no coincide con ninguna forma. Por eso
     * está deshabilitada, para no tener dos controles diciendo lo mismo.
     */
    const custom = el('option', null, 'A medida');
    custom.value = '';
    custom.disabled = true;
    select.appendChild(custom);

    for (const shape of Sequencer.CLIP_SHAPES) {
      const option = el('option', null, shape.name);
      option.value = shape.id;
      select.appendChild(option);
    }
  }

  function fillChanceOptions() {
    const select = $('seq-chance');
    select.textContent = '';
    IRFrame.CHANCE_PCT.forEach((pct, index) => {
      const option = el('option', null, `${pct} %`);
      option.value = String(index);
      select.appendChild(option);
    });
  }

  function fillEnvelopeOptions() {
    for (const id of envelopeSelects) {
      const select = $(id);
      select.textContent = '';
      IRFrame.TIMER_MS.forEach((ms, index) => {
        const option = el('option', null, `${index} · ${ms} ms`);
        option.value = String(index);
        select.appendChild(option);
      });
    }
  }

  /** Del estado del comando a los campos del panel. */
  function syncCommandInputs(source) {
    const { effect } = command;
    if (source !== 'picker') $('seq-color').value = toHex(effect.color).toLowerCase();
    if (source !== 'hex') $('seq-hex').value = toHex(effect.color);
    $('seq-attack').value = String(effect.attack);
    $('seq-sustain').value = String(effect.sustain);
    $('seq-release').value = String(effect.release);
    $('seq-chance').value = String(effect.chance || 0);

    const shape = Sequencer.matchShape(effect);
    $('seq-shape').value = shape ? shape.id : '';

    $('seq-panel-swatch').style.background = cssColor(IRFrame.quantizeColor(effect.color));
  }

  function setCommandColor(color, source) {
    command.effect.color = {
      r: IRFrame.clamp8(color.r),
      g: IRFrame.clamp8(color.g),
      b: IRFrame.clamp8(color.b),
    };
    commandChanged(source);
  }

  /*
   * El efecto tal y como se coloca: siempre configurable y con los campos que
   * tocan la memoria del aparato apagados a la fuerza. Un show tiene que sonar
   * igual en cualquier badge, y `gsten` toma el sostén de lo que el aparato
   * lleve guardado, mientras que `onStart` y `repeatEnabled` lo escriben.
   */
  function currentEffect() {
    return {
      ...command.effect,
      color: { ...command.effect.color },
      mode: 'configurable',
      useGlobalSustain: false,
      onStart: false,
      repeatEnabled: false,
    };
  }

  /** Nombre por color, igual que el del generador, para que los clips se lean igual. */
  function commandLabel() {
    const q = IRFrame.quantizeColor(command.effect.color);
    return `rgb(${q.r},${q.g},${q.b})`;
  }

  /*
   * Todo cambio del panel se aplica al clip abierto. El panel es el editor: no
   * hay un «modo colocar» y otro «modo editar», solo el clip que tienes delante,
   * y sus ajustes son los que se usarán para el siguiente que coloques.
   */
  function commandChanged(source) {
    syncCommandInputs(source);
    if (!view.editingClipId) return;
    const found = Sequencer.findClip(show, view.editingClipId);
    if (!found) {
      closePanel();
      return;
    }
    found.clip.effect = currentEffect();
    found.clip.transmission = { ...command.transmission };
    found.clip.label = commandLabel();
    transport.invalidate();
    renderTimeline();
    renderPanelFields();
    placePanel();
  }

  function renderPanelFields() {
    const found = view.editingClipId && Sequencer.findClip(show, view.editingClipId);
    const fields = $('seq-panel-fields');
    fields.textContent = '';
    if (!found) return;

    const { channel, clip } = found;
    $('seq-panel-title').textContent = `${clip.label} · ${channel.name}`;

    const rows = [
      ['Inicio', formatTime(clip.at)],
      ['Duración', `${Sequencer.clipDurationMs(clip)} ms`],
      [
        'Grupo',
        channel.group === Sequencer.BROADCAST_GROUP
          ? '0 · difusión, todos los badges'
          : `${channel.group} · solo ese grupo`,
      ],
    ];
    for (const [key, value] of rows) {
      fields.appendChild(el('dt', null, key));
      fields.appendChild(el('dd', null, value));
    }
  }

  /**
   * Coloca el panel junto a su clip: a la derecha si cabe, volteado a la
   * izquierda si no, y subido cuando se saldría por abajo. Si el clip se ha ido
   * de la vista al desplazar la línea de tiempo, el panel se cierra en vez de
   * quedarse flotando lejos del clip al que pertenece.
   */
  function placePanel() {
    if (panel.hidden) return;

    // A pantalla estrecha no hay hueco al lado: hoja inferior a ancho completo.
    const sheet = window.innerWidth <= 560;
    panel.classList.toggle('is-sheet', sheet);
    // El hueco al pie deja subir las pistas por encima de la hoja y seguir
    // arrastrando clips con el panel abierto.
    root.classList.toggle('has-sheet', sheet);
    if (sheet) {
      panel.style.left = '';
      panel.style.top = '';
      return;
    }

    const anchor = lanes.querySelector(`[data-clip="${view.editingClipId}"]`);
    if (!anchor) {
      closePanel();
      return;
    }

    const clipRect = anchor.getBoundingClientRect();
    const viewRect = scroll.getBoundingClientRect();
    if (clipRect.right < viewRect.left || clipRect.left > viewRect.right) {
      closePanel();
      return;
    }

    const size = panel.getBoundingClientRect();
    const margin = 10;
    let left = clipRect.right + margin;
    if (left + size.width > window.innerWidth - margin) left = clipRect.left - size.width - margin;
    left = Sequencer.clamp(left, margin, Math.max(margin, window.innerWidth - size.width - margin));

    let top = clipRect.top;
    if (top + size.height > window.innerHeight - margin) {
      top = window.innerHeight - size.height - margin;
    }
    top = Math.max(margin, top);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  /** Abre el panel sobre un clip y carga sus valores en los controles. */
  function openPanel(clipId) {
    const found = Sequencer.findClip(show, clipId);
    if (!found) return;

    view.editingClipId = clipId;
    select(clipId);

    command.effect = {
      attack: 2,
      sustain: 2,
      release: 2,
      chance: 0,
      ...found.clip.effect,
      color: { ...found.clip.effect.color },
    };
    command.transmission = { ...found.clip.transmission };

    syncCommandInputs();
    renderPanelFields();
    panel.hidden = false;
    placePanel();
    /*
     * El foco se lleva al panel en el cuadro siguiente: el gesto que lo abre
     * es un pointerdown, y el navegador aún tiene que aplicar su propio foco
     * por defecto —que se lo llevaría de vuelta al cuerpo—.
     */
    requestAnimationFrame(() => {
      if (!panel.hidden) $('seq-color').focus();
    });
  }

  function closePanel() {
    if (panel.hidden) return;
    panel.hidden = true;
    root.classList.remove('has-sheet');
    view.editingClipId = null;
  }

  function deleteSelected() {
    if (view.selectedClipId) deleteClip(view.selectedClipId);
  }

  /*
   * Pila de deshacer: solo guarda borrados, que es lo único que destruye
   * trabajo sin dejar rastro. Cada entrada sabe rehacer lo suyo, así que
   * Ctrl/Cmd+Z y el botón del aviso comparten camino.
   */
  const undoStack = [];
  const MAX_UNDO = 30;
  let undoTimer = null;

  function pushUndo(text, restore) {
    undoStack.push(restore);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    showUndo(text);
  }

  function showUndo(text) {
    const node = $('seq-undo');
    $('seq-undo-text').textContent = text;
    node.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { node.hidden = true; }, 6000);
  }

  function undoLast() {
    const restore = undoStack.pop();
    if (!restore) return false;
    restore();
    $('seq-undo').hidden = true;
    transport.invalidate();
    renderAll();
    return true;
  }

  /** Elimina un clip dejándolo recuperable. */
  function deleteClip(clipId) {
    const found = Sequencer.findClip(show, clipId);
    if (!found) return;
    const { channel, clip } = found;
    Sequencer.removeClip(show, clipId);
    if (view.selectedClipId === clipId) view.selectedClipId = null;
    if (view.editingClipId === clipId) closePanel();
    transport.invalidate();
    renderTimeline();
    pushUndo(`Clip eliminado de ${channel.name}`, () => {
      Sequencer.addClip(show, channel.id, clip);
    });
  }

  function duplicateClip(channel, clip) {
    const copy = Sequencer.createClip({
      at: clip.at + Sequencer.clipDurationMs(clip),
      label: clip.label,
      effect: clip.effect,
      transmission: clip.transmission,
    });
    Sequencer.addClip(show, channel.id, copy);
    transport.invalidate();
    renderTimeline();
    return copy;
  }

  // ------------------------------------------------------------ añadir clip

  function addCurrentCommand(channelId, at) {
    const clip = Sequencer.createClip({
      at,
      label: commandLabel(),
      effect: currentEffect(),
      transmission: { ...command.transmission },
    });
    Sequencer.addClip(show, channelId, clip);
    transport.invalidate();
    renderTimeline();
    // Colocar y abrir su panel es el mismo gesto que pulsar un clip existente.
    openPanel(clip.id);
  }

  // ------------------------------------------------------------- despacho

  function handleDispatch(event) {
    firing.push({ channelId: event.channelId, clip: event.clip, at: event.at });
    appendLog(event);
  }

  // ------------------------------------------------------------ indicadores

  /*
   * Clips sonando ahora mismo. Se anotan al despacharlos y se van apagando
   * solos según su envolvente; el reloj es el cursor del transporte y no el del
   * navegador, para que la previsualización siga al audio y se congele al
   * pausar igual que la línea de tiempo.
   */
  const firing = [];

  // Con movimiento reducido no se recorren rampas: color plano mientras dura.
  const flatMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  let firingIds = '';

  /**
   * Pinta los indicadores con la intensidad que tocaría en `cursor`.
   *
   * Solo escribe estilos: repintar las pistas enteras en cada frame se notaría
   * en cuanto el show tuviera unos cuantos canales.
   */
  function renderMeters(cursor) {
    for (let i = firing.length - 1; i >= 0; i--) {
      if (cursor < firing[i].at || cursor > firing[i].at + Sequencer.clipDurationMs(firing[i].clip)) {
        firing.splice(i, 1);
      }
    }

    const active = new Set();

    for (const channel of show.channels) {
      const meter = heads.querySelector(`[data-meter="${channel.id}"]`);
      if (!meter) continue;

      let level = 0;
      let color = null;
      for (const entry of firing) {
        if (entry.channelId !== channel.id) continue;
        const elapsed = cursor - entry.at;
        const value = flatMotion.matches ? 1 : Sequencer.clipIntensityAt(entry.clip, elapsed);
        if (value > level) {
          level = value;
          color = IRFrame.quantizeColor(entry.clip.effect.color);
        }
        if (value > 0) active.add(entry.clip.id);
      }

      paintMeter(meter, color, level);
    }

    // Marcar los clips que suenan solo cuando cambia el conjunto: tocar clases
    // en cada frame por cada clip sería tirar el rendimiento sin necesidad.
    const ids = [...active].sort().join(',');
    if (ids !== firingIds) {
      firingIds = ids;
      for (const node of lanes.querySelectorAll('.seq-clip')) {
        node.classList.toggle('is-firing', active.has(node.dataset.clip));
      }
    }
  }

  function paintMeter(node, color, level) {
    if (!color || level <= 0) {
      node.style.background = '';
      node.style.boxShadow = '';
      return;
    }
    const lit = {
      r: Math.round(color.r * level),
      g: Math.round(color.g * level),
      b: Math.round(color.b * level),
    };
    node.style.background = cssColor(lit);
    node.style.boxShadow = `0 0 ${Math.round(26 * level)}px ${Math.round(4 * level)}px ${cssColor(lit)}`;
  }

  /*
   * Envíos aún sin respuesta, por clip e instante. El transporte no espera a la
   * red, así que la línea del registro nace como «esperando» y se corrige
   * cuando el dispositivo contesta. Si el mismo clip vuelve a sonar en un
   * bucle, la entrada se reemplaza: solo interesa el último desenlace.
   */
  const pendingRows = new Map();
  const dispatchKey = event => `${event.clip.id}@${event.at}`;

  function settleLogRow({ event, ok, error, detail }) {
    const row = pendingRows.get(dispatchKey(event));
    if (!row) return;
    pendingRows.delete(dispatchKey(event));
    row.classList.toggle('is-error', !ok);
    const bytes = row.querySelector('.seq-log-bytes');
    if (bytes) bytes.textContent = ok ? detail || 'aceptada' : error || 'sin respuesta';
  }

  function appendLog(event) {
    const row = el('li', 'seq-log-row');
    if (!event.result.ok) row.classList.add('is-error');
    if (event.result.pending) pendingRows.set(dispatchKey(event), row);

    row.appendChild(el('span', 'seq-log-time', formatTime(event.at)));
    row.appendChild(el('span', 'seq-log-ch', event.channelName));

    const dot = el('span', 'seq-log-dot');
    dot.style.background = cssColor(IRFrame.quantizeColor(event.clip.effect.color));
    row.appendChild(dot);

    row.appendChild(el('span', 'seq-log-label', event.clip.label));
    row.appendChild(
      el(
        'code',
        'seq-log-bytes',
        !event.result.ok
          ? event.result.error
          : event.result.pending
            ? event.result.detail
            : event.result.frame.encoded.map(IRFrame.hexByte).join(' '),
      ),
    );

    logList.appendChild(row);
    // Sin tope, un show en bucle acabaría con decenas de miles de nodos.
    while (logList.children.length > 200) logList.removeChild(logList.firstChild);
    logList.parentElement.scrollTop = logList.parentElement.scrollHeight;
  }

  // ------------------------------------------------------------- transporte

  function renderTransportState(state) {
    $('seq-play').setAttribute('aria-pressed', String(state.playing));
    $('seq-play').textContent = state.playing ? '❚❚ Pausa' : '▶ Reproducir';
    $('seq-time').textContent = formatTime(state.cursor);
    $('seq-duration').textContent = formatTime(state.duration);
    playhead.style.transform = `translateX(${msToPx(state.cursor)}px)`;
  }

  /*
   * Con pista cargada el reloj lo manda el audio: el cabezal se fija en la
   * posición absoluta de la canción en vez de ir sumando deltas, que es lo que
   * mantiene los clips pegados a los golpes aunque el elemento de audio
   * resincronice por su cuenta. Sin pista, sigue mandando requestAnimationFrame.
   */
  function frame(now) {
    const state =
      audio.element && !audio.element.paused
        ? transport.syncTo(audio.element.currentTime * 1000)
        : transport.advance(now);
    if (state.playing) {
      $('seq-time').textContent = formatTime(state.cursor);
      playhead.style.transform = `translateX(${msToPx(state.cursor)}px)`;
      keepPlayheadVisible(state.cursor);
    }
    // Parado y sin nada encendido no hay nada que repintar.
    if (state.playing || firing.length) renderMeters(state.cursor);
    requestAnimationFrame(frame);
  }

  function keepPlayheadVisible(cursor) {
    const x = msToPx(cursor);
    const left = scroll.scrollLeft;
    const right = left + scroll.clientWidth;
    if (x < left || x > right - 60) scroll.scrollLeft = Math.max(0, x - 80);
  }

  // -------------------------------------------------------------- exportar

  function exportShow() {
    const data = JSON.stringify(Sequencer.toJSON(show), null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${Exporters.slug(show.name || 'show')}-show.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  /*
   * PRINCIPIO DEL PROYECTO, igual que con la música: el archivo del show se lee
   * con FileReader dentro del navegador y no se sube a ningún sitio. No hay
   * servidor al que mandarlo ni lo va a haber.
   */
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
      reader.readAsText(file);
    });
  }

  const clipCount = () => show.channels.reduce((total, c) => total + c.clips.length, 0);

  // ------------------------------------------------------------- sesiones

  /*
   * El trabajo se guarda solo en el navegador, para que cerrar la pestaña sin
   * querer no cueste el show. La lógica vive en el modelo con el almacenamiento
   * inyectado; aquí solo se decide cuándo guardar y cómo se ve la lista.
   *
   * `localStorage` puede lanzar en cuanto se toca —modo privado, permisos
   * bloqueados—, así que hasta obtener el objeto va en try/catch: sin sesiones
   * la pestaña funciona igual, solo que sin red de seguridad.
   */
  const sessions = Sequencer.createSessionStore({ storage: safeStorage() });

  function safeStorage() {
    try {
      // Una escritura de prueba: hay navegadores donde el objeto existe pero
      // cualquier operación lanza, y es mejor enterarse aquí que a mitad de faena.
      localStorage.setItem('ir-frame.prueba', '1');
      localStorage.removeItem('ir-frame.prueba');
      return localStorage;
    } catch {
      return { getItem: () => null, setItem: () => {} };
    }
  }

  const session = { id: null, name: 'Sesión', audioName: null };
  let saveTimer = null;
  let autosaveReady = false;

  const formatDate = ms => {
    if (!ms) return 'sin fecha';
    const date = new Date(ms);
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} ` +
      `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  function sessionState(text) {
    $('seq-session-state').textContent = text;
  }

  /*
   * Con retardo: un arrastre dispara un repintado por píxel y serializar el
   * show en cada uno se notaría. Unos cientos de milisegundos bastan para que
   * solo se guarde el resultado.
   */
  function markDirty() {
    if (!autosaveReady) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 400);
  }

  function saveSession() {
    // Sin sesión previa ni nada que guardar no se crea una vacía por las buenas.
    if (!session.id && !clipCount()) return;
    // La primera vez la sesión toma el nombre del show, que es lo que se reconoce.
    if (!session.id && session.name === 'Sesión') session.name = show.name || 'Sesión';
    const result = sessions.save({
      id: session.id,
      name: session.name,
      show,
      view: {
        pxPerSecond: view.pxPerSecond,
        snapMs: view.snapMs,
        tab: view.tab,
        logOpen: view.logOpen,
      },
      audioName: audio.samples ? audio.name : session.audioName,
    });
    if (!result.ok) {
      sessionState(`No se pudo guardar: ${result.error}`);
      return;
    }
    session.id = result.id;
    sessionState(`Guardado ${formatDate(Date.now())}`);
    renderSessionList();
  }

  function renderSessionList() {
    const select = $('seq-session-list');
    select.textContent = '';
    const saved = sessions.list();

    if (!saved.length) {
      const empty = el('option', null, 'Sin sesiones guardadas');
      empty.value = '';
      select.appendChild(empty);
      select.disabled = true;
    } else {
      select.disabled = false;
      for (const item of saved) {
        const option = el(
          'option',
          null,
          `${item.name} · ${formatDate(item.updatedAt)} · ` +
            `${item.clips} ${item.clips === 1 ? 'clip' : 'clips'}`,
        );
        option.value = item.id;
        select.appendChild(option);
      }
    }
    if (session.id) select.value = session.id;
    $('seq-session-name').value = session.name;
    $('seq-session-delete').disabled = !session.id;
  }

  /** Vuelca una sesión cargada sobre el estado abierto. */
  function applySession(loaded) {
    if (transport.state().playing) transport.pause();
    if (audio.element) audio.element.pause();

    show.name = loaded.show.name;
    show.channels = loaded.show.channels;
    session.id = loaded.id;
    session.name = loaded.name;
    session.audioName = loaded.audioName;

    if (loaded.view && loaded.view.pxPerSecond) {
      view.pxPerSecond = loaded.view.pxPerSecond;
      $('seq-zoom').value = String(view.pxPerSecond);
    }
    if (loaded.view && loaded.view.snapMs != null) {
      view.snapMs = loaded.view.snapMs;
      $('seq-snap').value = String(view.snapMs);
    }
    if (loaded.view && loaded.view.tab) showTab(loaded.view.tab);
    if (loaded.view && loaded.view.logOpen != null) showLog(Boolean(loaded.view.logOpen));

    closePanel();
    view.selectedClipId = null;
    undoStack.length = 0;
    logList.textContent = '';
    pendingRows.clear();
    $('seq-name').value = show.name;
    transport.invalidate();
    transport.seek(0);
    renderAll();
    renderSessionList();
  }

  function loadSession(id) {
    const result = sessions.load(id);
    if (!result.ok) {
      // Una sesión ilegible se descarta: arrancar en blanco es mejor que
      // arrancar roto, pero se dice por qué.
      sessionState(`Sesión descartada: ${result.error}`);
      renderSessionList();
      return false;
    }
    applySession(result.session);
    sessionState(`Cargada «${result.session.name}» del ${formatDate(result.session.updatedAt)}`);
    if (result.session.audioName) {
      bridge.toast(
        `Esta sesión usaba «${result.session.audioName}»: vuelve a seleccionarlo, ` +
          'el audio no se guarda en el navegador.',
      );
    }
    return true;
  }

  /** Deja el secuenciador como recién abierto, sin sesión asociada. */
  function startFresh(name) {
    const fresh = Sequencer.createShow({ name: name || 'Show sin título' });
    applySession({
      id: null,
      name: name || 'Sesión nueva',
      audioName: null,
      view: {},
      show: fresh,
    });
  }

  function restoreLastSession() {
    const last = sessions.latest();
    if (!last) {
      sessionState('Sin sesiones guardadas todavía');
      renderSessionList();
      return;
    }
    if (!loadSession(last.id)) {
      // La última estaba rota y ya se ha descartado: se arranca con lo de siempre.
      sessionState('La última sesión no se pudo leer: se ha empezado con el show por omisión');
    }
  }

  async function importShow(file) {
    let loaded;
    let data;
    try {
      /*
       * Se valida y se construye el show entero ANTES de tocar nada: si el
       * archivo está corrupto, lo que hay abierto se queda como estaba.
       */
      data = JSON.parse(await readFileText(file));
      loaded = Sequencer.fromJSON(data);
    } catch (error) {
      const reason =
        error instanceof SyntaxError ? 'el archivo no es JSON válido' : error.message;
      bridge.toast(`No se pudo cargar el show: ${reason}`);
      return;
    }

    const losing = clipCount();
    if (losing) {
      const ok = await askConfirm({
        title: 'Reemplazar el show abierto',
        text:
          (losing === 1
            ? 'Se descartará el clip que hay ahora. '
            : `Se descartarán los ${losing} clips que hay ahora. `) +
          'Guarda el show actual antes si quieres conservarlo.',
        action: 'Cargar de todas formas',
      });
      if (!ok) return;
    }

    if (transport.state().playing) transport.pause();
    if (audio.element) audio.element.pause();

    show.name = loaded.name;
    show.channels = loaded.channels;
    closePanel();
    view.selectedClipId = null;
    undoStack.length = 0;
    logList.textContent = '';
    pendingRows.clear();
    transport.invalidate();
    transport.seek(0);
    seekAudio(0);

    // Un show mucho más largo que la vista entraría fuera de pantalla: se aleja
    // el zoom lo justo para verlo entero antes de pintar.
    fitZoomToShow();
    renderAll();

    if (data.version == null || data.version < Sequencer.SHOW_VERSION) {
      bridge.toast(
        'Show de un formato anterior: los canales no traían grupo y se han ' +
          'asignado por orden (el primero difusión, los demás correlativos).',
      );
    } else {
      bridge.toast(`Show cargado: ${show.name}`);
    }
  }

  /** Aleja el zoom hasta que el show quepa en el ancho visible, sin pasarse. */
  function fitZoomToShow() {
    const visible = scroll.clientWidth || 600;
    const needed = (visible / Math.max(1000, spanMs())) * 1000;
    const input = $('seq-zoom');
    const min = Number(input.min) || 20;
    if (needed < view.pxPerSecond) {
      view.pxPerSecond = Math.max(min, Math.floor(needed));
      input.value = String(view.pxPerSecond);
    }
  }

  function exportFrames(formatKey) {
    const entries = Sequencer.toExportEntries(show);
    if (!entries.length) {
      bridge.toast('El show está vacío');
      return;
    }
    Exporters.download(formatKey, entries, `${Exporters.slug(show.name || 'show')}-show`);
    bridge.toast(`Descargando ${entries.length} comandos`);
  }

  // ----------------------------------------------------- pantalla completa

  const ROW_MIN_PX = 38;
  const ROW_MAX_PX = 110;

  function inNativeFullscreen() {
    return document.fullscreenElement === root;
  }

  /*
   * La Fullscreen API es lo que de verdad aprovecha la pantalla, pero puede
   * fallar (permisos, navegadores sin ella) y no puede quedarse a medias: la
   * clase `is-full` deja el panel ocupando la ventana igualmente, y es la misma
   * clase en los dos casos para no tener dos diseños que mantener.
   */
  async function toggleFullscreen() {
    if (inNativeFullscreen()) {
      document.exitFullscreen();
      return;
    }
    if (view.fullscreen) {
      setFullscreen(false);
      return;
    }
    try {
      if (!root.requestFullscreen) throw new Error('sin Fullscreen API');
      await root.requestFullscreen();
    } catch {
      setFullscreen(true);
    }
  }

  function setFullscreen(value) {
    view.fullscreen = value;
    root.classList.toggle('is-full', value);
    const button = $('seq-fullscreen');
    const label = value
      ? 'Salir de la pantalla completa'
      : 'Ver el secuenciador a pantalla completa';
    button.setAttribute('aria-pressed', String(value));
    button.textContent = value ? '⤡' : '⛶';
    button.title = label;
    button.setAttribute('aria-label', label);
    // El navegador aún no ha recolocado nada cuando termina este cuadro.
    requestAnimationFrame(fitTracks);
  }

  /**
   * Reparte el alto disponible entre las pistas y vuelve a medir la línea de
   * tiempo. Hace falta al entrar y al salir de pantalla completa, y también al
   * cambiar el tamaño de la ventana: el ancho del lienzo de la onda y el alto
   * de fila son píxeles calculados, no porcentajes.
   */
  function fitTracks() {
    if (view.fullscreen) {
      const ruleHeight = ruler.offsetHeight || 30;
      // La onda ocupa su propia fila, así que su alto no se reparte entre pistas.
      const waveHeight = waveLane.hidden ? 0 : waveLane.offsetHeight;
      // El pie de la columna de cabeceras («+ Canal») no es una pista, pero
      // ocupa alto en la misma rejilla: si no se descuenta, el botón se sale.
      const footHeight = root.querySelector('.seq-headfoot').offsetHeight;
      const available = grid.clientHeight - ruleHeight - waveHeight - footHeight;
      const row = Math.round(available / Math.max(1, show.channels.length));
      root.style.setProperty(
        '--seq-row',
        `${Sequencer.clamp(row, ROW_MIN_PX, ROW_MAX_PX)}px`,
      );
    } else {
      root.style.removeProperty('--seq-row');
    }
    renderTimeline();
    renderTransportState(transport.state());
  }

  // --------------------------------------------------------------- pintado

  function renderTimeline() {
    renderRuler();
    renderChannels();
    drawWave();
  }

  function renderAll() {
    renderTimeline();
    renderAudioState();
    renderTransportState(transport.state());
  }

  // ---------------------------------------------------------------- eventos

  $('seq-play').addEventListener('click', () => {
    if (transport.state().playing) {
      if (audio.element) audio.element.pause();
      transport.pause();
      return;
    }
    if (audio.element) {
      seekAudio(transport.state().cursor);
      audio.element.play().catch(error => bridge.toast(`No se pudo reproducir: ${error.message}`));
    }
    transport.play();
  });

  $('seq-rewind').addEventListener('click', () => {
    // El audio se rebobina con el show para que no se descuadren entre sí.
    if (audio.element) audio.element.currentTime = 0;
    transport.rewind();
    renderTransportState(transport.state());
  });

  /**
   * Pliega y despliega el registro. Con `hidden` el cuerpo sale del flujo, así
   * que plegado no queda hueco muerto y en pantalla completa la línea de tiempo
   * se queda con el sitio.
   */
  function showLog(open) {
    view.logOpen = open;
    $('seq-log-body').hidden = !open;
    const toggle = $('seq-log-toggle');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Plegar' : 'Desplegar';
    fitTracks();
  }

  $('seq-log-toggle').addEventListener('click', () => {
    showLog(!view.logOpen);
    markDirty();
  });

  $('seq-stop').addEventListener('click', () => {
    if (audio.element) {
      audio.element.pause();
      audio.element.currentTime = 0;
    }
    transport.stop();
    renderTransportState(transport.state());
  });

  $('seq-loop').addEventListener('change', event => transport.setLoop(event.target.checked));

  $('seq-zoom').addEventListener('input', event => {
    view.pxPerSecond = Number(event.target.value);
    renderTimeline();
    renderTransportState(transport.state());
  });

  $('seq-snap').addEventListener('change', event => {
    view.snapMs = Number(event.target.value);
    markDirty();
  });

  $('seq-transmitter').addEventListener('change', event => {
    transmitter = transmitters[event.target.value] || transmitters.emulado;
    transport.setTransmitter(transmitter);
    const device = transmitter.id === 'dispositivo';
    $('seq-device').hidden = !device;
    $('seq-device-status').textContent = '';
    $('seq-log-hint').textContent = device
      ? 'Dispositivo: cada trama se envía por HTTP y el registro recoge lo que responda.'
      : 'Emulación: las tramas se codifican y se registran, pero no se transmiten.';
  });

  // ------------------------------------------------------------ dispositivo

  function rebuildDeviceTransmitter() {
    const baseUrl = $('seq-device-url').value.trim() || 'http://led-badge.local';
    try {
      localStorage.setItem(DEVICE_URL_KEY, baseUrl);
    } catch {
      // Sin almacenamiento la dirección simplemente no se recuerda.
    }
    transmitters.dispositivo = Sequencer.createDeviceTransmitter({
      baseUrl,
      onResult: settleLogRow,
    });
    if (transmitter.id === 'dispositivo') {
      transmitter = transmitters.dispositivo;
      transport.setTransmitter(transmitter);
    }
    return transmitters.dispositivo;
  }

  $('seq-device-url').addEventListener('change', () => {
    rebuildDeviceTransmitter();
    $('seq-device-status').textContent = '';
  });

  $('seq-device-test').addEventListener('click', async () => {
    const device = rebuildDeviceTransmitter();
    const status = $('seq-device-status');
    status.textContent = 'Probando…';
    const result = await device.test();
    status.textContent = result.ok
      ? `Responde: ${result.detail}`
      : `No responde: ${result.error}. Recuerda que desde HTTPS el navegador ` +
        'bloquea la petición antes de intentarla.';
  });

  // ------------------------------------------------------------------ audio

  $('seq-audio-file').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      await loadAudio(file);
      session.audioName = audio.name;
      markDirty();
      bridge.toast(`Pista cargada: ${file.name}`);
    } catch (error) {
      releaseAudio();
      bridge.toast(`No se pudo leer el audio: ${error.message}`);
    }
    renderAudioState();
    renderTimeline();
  });

  $('seq-audio-clear').addEventListener('click', () => {
    releaseAudio();
    $('seq-audio-file').value = '';
    renderAudioState();
    renderTimeline();
  });

  // ----------------------------------------------------- pantalla completa

  $('seq-fullscreen').addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === root || view.fullscreen) {
      setFullscreen(inNativeFullscreen());
    }
  });

  window.addEventListener('resize', fitTracks);

  // --------------------------------------------------------- comando propio

  $('seq-color').addEventListener('input', event => {
    const color = parseHex(event.target.value);
    if (color) setCommandColor(color, 'picker');
  });

  $('seq-hex').addEventListener('change', event => {
    const color = parseHex(event.target.value);
    if (color) setCommandColor(color, 'hex');
    else syncCommandInputs();
  });

  for (const [id, key] of [
    ['seq-attack', 'attack'],
    ['seq-sustain', 'sustain'],
    ['seq-release', 'release'],
  ]) {
    $(id).addEventListener('change', event => {
      command.effect[key] = Number(event.target.value);
      commandChanged();
    });
  }

  $('seq-chance').addEventListener('change', event => {
    command.effect.chance = Number(event.target.value);
    commandChanged();
  });

  /*
   * Las formas son datos del modelo: aquí solo se copian encima del comando.
   * El color no se toca, que es lo que distingue un show de otro.
   */
  $('seq-shape').addEventListener('change', event => {
    const shape = Sequencer.CLIP_SHAPES.find(item => item.id === event.target.value);
    if (!shape) return;
    command.effect = {
      ...command.effect,
      mode: 'configurable',
      attack: 0,
      sustain: 0,
      release: 0,
      chance: 0,
      ...shape.effect,
    };
    commandChanged();
  });

  $('seq-panel-close').addEventListener('click', () => {
    const anchor = lanes.querySelector(`[data-clip="${view.editingClipId}"]`);
    closePanel();
    if (anchor) anchor.focus();
  });

  /*
   * Emite el clip abierto por la salida seleccionada sin reproducir el show:
   * ajustar un comando mirando el badge no debería obligar a montar una
   * reproducción entera. Va por el mismo camino que el transporte —el mismo
   * transmisor y el mismo registro—, así que un envío asíncrono se corrige solo
   * cuando llega la respuesta.
   */
  $('seq-panel-test').addEventListener('click', () => {
    const found = Sequencer.findClip(show, view.editingClipId);
    if (!found) return;
    const { channel, clip } = found;
    const event = {
      at: transport.state().cursor,
      clip,
      channelId: channel.id,
      channelName: channel.name,
      group: channel.group,
      effect: Sequencer.effectFor(channel, clip),
    };
    event.result = transmitter.send(event);
    appendLog(event);
    bridge.toast(
      event.result.ok
        ? `Probado por ${transmitter.name}`
        : `No se pudo probar: ${event.result.error}`,
    );
  });

  $('seq-panel-duplicate').addEventListener('click', () => {
    const found = Sequencer.findClip(show, view.editingClipId);
    if (!found) return;
    openPanel(duplicateClip(found.channel, found.clip).id);
  });

  $('seq-panel-distribute').addEventListener('click', () => {
    const box = $('seq-distribute');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      $('seq-dist-every').focus();
      placePanel();
    }
  });

  $('seq-dist-apply').addEventListener('click', () => {
    const found = Sequencer.findClip(show, view.editingClipId);
    if (!found) return;
    let result;
    try {
      result = Sequencer.distributeClip(show, found.clip.id, {
        everyMs: Number($('seq-dist-every').value),
        untilMs: Number($('seq-dist-until').value) * 1000,
      });
    } catch (error) {
      bridge.toast(error.message);
      return;
    }
    transport.invalidate();
    renderTimeline();
    placePanel();
    bridge.toast(
      result.copies.length
        ? `${result.copies.length} copias repartidas` +
            (result.capped ? ` (${result.reason})` : '')
        : `No se repartió ninguna copia: ${result.reason}`,
    );
  });

  $('seq-panel-delete').addEventListener('click', () => {
    select(view.editingClipId);
    deleteSelected();
  });

  /*
   * El panel vive anclado a un clip concreto: si la línea de tiempo se mueve
   * bajo él, o cambia el zoom, se recoloca; y si el clip se va de la vista,
   * placePanel lo cierra.
   */
  scroll.addEventListener('scroll', placePanel);

  document.addEventListener('pointerdown', event => {
    if (panel.hidden || panel.contains(event.target)) return;
    // Un clic en la línea de tiempo ya decide por su cuenta qué panel abrir.
    if (event.target.closest('.seq-clip') || event.target.closest('.seq-lane')) return;
    closePanel();
  });

  $('seq-undo-btn').addEventListener('click', () => {
    if (!undoLast()) bridge.toast('No hay nada que deshacer');
  });

  $('seq-confirm-cancel').addEventListener('click', () => closeConfirm(false));
  $('seq-confirm-ok').addEventListener('click', () => closeConfirm(true));
  // Pulsar fuera del cuadro es cancelar, que es la opción segura.
  $('seq-confirm').addEventListener('pointerdown', event => {
    if (event.target === $('seq-confirm')) closeConfirm(false);
  });

  $('seq-import-show').addEventListener('click', () => $('seq-import-file').click());
  $('seq-import-file').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    // El valor se limpia para poder recargar el mismo archivo dos veces.
    event.target.value = '';
    if (file) importShow(file);
  });

  $('seq-add-channel').addEventListener('click', () => {
    try {
      Sequencer.addChannel(show);
    } catch (error) {
      bridge.toast(error.message);
      return;
    }
    transport.invalidate();
    renderAll();
  });

  $('seq-clear-log').addEventListener('click', () => {
    logList.textContent = '';
    pendingRows.clear();
  });

  $('seq-export-show').addEventListener('click', exportShow);
  $('seq-export-frames').addEventListener('change', event => {
    if (!event.target.value) return;
    exportFrames(event.target.value);
    event.target.value = '';
  });

  $('seq-name').addEventListener('change', event => {
    show.name = event.target.value.trim() || 'Show sin título';
    markDirty();
  });

  /*
   * Conmutador de pestañas de la caja de ajustes. Es un `tablist` de verdad —no
   * un grupo de botones con apariencia de pestañas—: una sola parada de
   * tabulación, y dentro se circula con las flechas.
   */
  const tabs = Array.from(document.querySelectorAll('.seq-tabs .seq-tab'));

  function tabId(button) {
    return button.id.replace('seq-tab-', '');
  }

  function showTab(id, { focus = false } = {}) {
    const target = tabs.find(button => tabId(button) === id) || tabs[0];
    for (const button of tabs) {
      const on = button === target;
      button.setAttribute('aria-selected', String(on));
      // Roving tabindex: solo la pestaña activa recibe el tabulador.
      button.tabIndex = on ? 0 : -1;
      const panel = $(button.getAttribute('aria-controls'));
      panel.classList.toggle('is-on', on);
    }
    view.tab = tabId(target);
    if (focus) target.focus();
    markDirty();
  }

  for (const button of tabs) {
    button.addEventListener('click', () => showTab(tabId(button)));
  }

  document.querySelector('.seq-tabs').addEventListener('keydown', event => {
    const paso = { ArrowRight: 1, ArrowLeft: -1, Home: 'inicio', End: 'fin' }[event.key];
    if (paso === undefined) return;
    event.preventDefault();
    const actual = tabs.findIndex(button => button.getAttribute('aria-selected') === 'true');
    let siguiente;
    if (paso === 'inicio') siguiente = 0;
    else if (paso === 'fin') siguiente = tabs.length - 1;
    else siguiente = (actual + paso + tabs.length) % tabs.length;
    showTab(tabId(tabs[siguiente]), { focus: true });
  });

  $('seq-session-list').addEventListener('change', event => {
    if (event.target.value) loadSession(event.target.value);
  });

  $('seq-session-name').addEventListener('change', event => {
    session.name = event.target.value.trim() || 'Sesión';
    if (session.id) sessions.rename(session.id, session.name);
    else saveSession();
    renderSessionList();
  });

  /*
   * Guardar una nueva no pisa la anterior: la actual ya está guardada por el
   * autoguardado, así que basta con soltar su identificador y empezar otra.
   */
  $('seq-session-new').addEventListener('click', () => {
    saveSession();
    startFresh();
    session.name = `Sesión ${sessions.list().length + 1}`;
    saveSession();
    renderSessionList();
    sessionState(`Nueva sesión: «${session.name}»`);
  });

  $('seq-session-delete').addEventListener('click', async () => {
    if (!session.id) return;
    const losing = clipCount();
    if (losing) {
      const ok = await askConfirm({
        title: `Eliminar «${session.name}»`,
        text:
          (losing === 1
            ? 'Se perderá su único clip.'
            : `Se perderán sus ${losing} clips.`) + ' Esto no se puede deshacer.',
        action: 'Eliminar sesión',
      });
      if (!ok) return;
    }
    sessions.remove(session.id);
    session.id = null;
    startFresh();
    renderSessionList();
    sessionState('Sesión eliminada');
  });

  $('seq-session-reset').addEventListener('click', async () => {
    const losing = clipCount();
    if (losing) {
      const ok = await askConfirm({
        title: 'Empezar de cero',
        text:
          (losing === 1
            ? 'Se descartará el clip que hay ahora'
            : `Se descartarán los ${losing} clips que hay ahora`) +
          ' y la sesión actual. Guarda el show en un archivo si quieres conservarlo.',
        action: 'Empezar de cero',
      });
      if (!ok) return;
    }
    if (session.id) sessions.remove(session.id);
    session.id = null;
    startFresh();
    renderSessionList();
    sessionState('Empezado de cero');
  });

  // Mover el cabezal pulsando en la regla; con pista cargada, también el audio.
  ruler.addEventListener('pointerdown', event => {
    const at = Math.max(0, pxToMs(event.offsetX));
    transport.seek(at);
    seekAudio(at);
  });

  /*
   * Escape cierra el panel del clip y sale de la pantalla completa. De la
   * nativa suele salir el navegador por su cuenta, pero pedirlo también aquí
   * evita quedarse dentro si no lo hace. Va aparte de los atajos de clip
   * porque debe funcionar aunque no haya nada seleccionado.
   */
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || root.hidden) return;
    if (confirmOpen()) {
      closeConfirm(false);
      return;
    }
    if (!panel.hidden) {
      const anchor = lanes.querySelector(`[data-clip="${view.editingClipId}"]`);
      closePanel();
      if (anchor) anchor.focus();
      return;
    }
    if (inNativeFullscreen()) document.exitFullscreen();
    else if (view.fullscreen) setFullscreen(false);
  });

  /*
   * Los atajos solo actúan cuando el foco está dentro del secuenciador y no en
   * un campo de texto: si no, escribir el nombre de un canal borraría clips.
   */
  /*
   * Deshacer va aparte de los atajos de clip: tiene que funcionar sin nada
   * seleccionado y también con el foco en un campo, que es donde suele estar
   * justo después de borrar sin querer.
   */
  document.addEventListener('keydown', event => {
    if (root.hidden || confirmOpen()) return;
    if (event.key.toLowerCase() !== 'z' || !(event.ctrlKey || event.metaKey) || event.shiftKey) {
      return;
    }
    /*
     * Dentro de un campo manda el deshacer del navegador: ahí el atajo sirve
     * para recuperar lo que se estaba escribiendo, no un clip.
     */
    const activo = document.activeElement;
    const tag = activo ? activo.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    if (!undoLast()) bridge.toast('No hay nada que deshacer');
  });

  document.addEventListener('keydown', event => {
    if (root.hidden || confirmOpen() || !view.selectedClipId) return;
    if (!root.contains(document.activeElement)) return;
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelected();
      return;
    }
    const step = event.shiftKey ? (view.snapMs || 10) * 10 : view.snapMs || 10;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const found = Sequencer.findClip(show, view.selectedClipId);
      if (!found) return;
      const delta = event.key === 'ArrowLeft' ? -step : step;
      Sequencer.moveClip(show, found.clip.id, Math.max(0, found.clip.at + delta));
      transport.invalidate();
      renderTimeline();
      select(found.clip.id);
      if (view.editingClipId === found.clip.id) {
        renderPanelFields();
        placePanel();
      }
    }
  });

  fillEnvelopeOptions();
  fillShapeOptions();
  fillChanceOptions();
  syncCommandInputs();
  $('seq-device-url').value = storedDeviceUrl();
  renderAll();
  restoreLastSession();
  // Desde aquí, cualquier repintado de pistas pide guardar.
  autosaveReady = true;
  requestAnimationFrame(frame);
})();
