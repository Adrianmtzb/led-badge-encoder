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
      effect: { color: { r: 240, g: 80, b: 0 }, mode: 'short' },
      transmission: {},
    }),
    toast: () => {},
  };

  // ----------------------------------------------------------------- estado

  const view = {
    pxPerSecond: 90,
    snapMs: 100,
    selectedClipId: null,
    // Sin un mínimo, un show vacío no tendría dónde soltar el primer clip.
    minSpanMs: 12000,
  };

  const show = Sequencer.createShow({ name: 'Show sin título' });
  const transmitters = { emulado: Sequencer.createEmulatedTransmitter() };
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

  function formatTime(ms) {
    const total = Math.max(0, ms);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = Math.floor(total % 1000);
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  /** Ancho útil de la línea de tiempo: el show más un margen para seguir añadiendo. */
  const spanMs = () =>
    Math.max(view.minSpanMs, Sequencer.showDurationMs(show) + 4000);

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
  const inspector = $('seq-inspector');

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

  // ----------------------------------------------------------------- pistas

  function renderChannels() {
    heads.textContent = '';
    lanes.textContent = '';

    // Alinea la primera pista con la regla, que ocupa su propia fila.
    heads.appendChild(el('div', 'seq-head-spacer'));

    const anySolo = show.channels.some(c => c.solo);

    for (const channel of show.channels) {
      const head = el('div', 'seq-head');
      if (!Sequencer.channelAudible(show, channel)) head.classList.add('is-silent');

      const led = el('span', 'seq-led');
      led.dataset.led = channel.id;
      head.appendChild(led);

      const name = el('input', 'seq-name');
      name.value = channel.name;
      name.setAttribute('aria-label', `Nombre del canal ${channel.name}`);
      name.addEventListener('change', () => {
        channel.name = name.value.trim() || 'Canal';
        transport.invalidate();
        renderChannels();
      });
      head.appendChild(name);

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

      const remove = el('button', 'seq-toggle', '×');
      remove.type = 'button';
      remove.title = 'Eliminar canal';
      remove.addEventListener('click', () => {
        if (show.channels.length === 1) {
          bridge.toast('Debe quedar al menos un canal');
          return;
        }
        show.channels.splice(show.channels.indexOf(channel), 1);
        transport.invalidate();
        renderAll();
      });
      buttons.appendChild(remove);

      head.appendChild(buttons);
      if (channel.muted) mute.classList.add('is-on');
      heads.appendChild(head);

      lanes.appendChild(buildLane(channel));
    }
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
   * mitad; el nombre completo sigue estando en el inspector y en las descargas.
   */
  function compactLabel(label, color) {
    if (!/^rgb\(/i.test(label)) return label;
    const hex = v => v.toString(16).padStart(2, '0').toUpperCase();
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
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

    node.appendChild(el('span', 'seq-clip-label', compactLabel(clip.label, quantized)));
    node.setAttribute(
      'aria-label',
      `${clip.label} en ${channel.name}, ${formatTime(clip.at)}. ` +
        'Arrastra para mover, Suprimir para eliminar.',
    );

    attachDrag(node, channel, clip);
    return node;
  }

  // --------------------------------------------------------------- arrastre

  function attachDrag(node, channel, clip) {
    let dragging = false;
    let moved = false;
    let grabOffsetPx = 0;

    node.addEventListener('pointerdown', event => {
      event.stopPropagation();
      dragging = true;
      moved = false;
      grabOffsetPx = event.clientX - node.getBoundingClientRect().left;
      node.setPointerCapture(event.pointerId);
      select(clip.id);
    });

    node.addEventListener('pointermove', event => {
      if (!dragging) return;
      const laneRect = node.parentElement.getBoundingClientRect();
      const left = event.clientX - laneRect.left - grabOffsetPx;
      const at = snap(Math.max(0, pxToMs(left)));
      if (at !== clip.at) {
        moved = true;
        clip.at = at;
        node.style.left = `${msToPx(at)}px`;
        renderInspector();
      }
    });

    const end = event => {
      if (!dragging) return;
      dragging = false;
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      if (moved) {
        Sequencer.moveClip(show, clip.id, clip.at);
        transport.invalidate();
        renderTimeline();
      }
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------- selección

  function select(clipId) {
    view.selectedClipId = clipId;
    for (const node of lanes.querySelectorAll('.seq-clip')) {
      node.classList.toggle('is-selected', node.dataset.clip === clipId);
    }
    renderInspector();
  }

  function renderInspector() {
    inspector.textContent = '';
    const found = view.selectedClipId && Sequencer.findClip(show, view.selectedClipId);

    if (!found) {
      inspector.appendChild(
        el(
          'p',
          'hint',
          'Pulsa una pista vacía para colocar el comando que tengas en el ' +
            'generador. Selecciona un clip para ver sus datos.',
        ),
      );
      return;
    }

    const { channel, clip } = found;
    const quantized = IRFrame.quantizeColor(clip.effect.color);
    const frame = IRFrame.encodeEffect(clip.effect, clip.transmission);

    const head = el('div', 'seq-inspector-head');
    const swatch = el('span', 'seq-swatch');
    swatch.style.background = cssColor(quantized);
    head.appendChild(swatch);
    head.appendChild(el('strong', null, clip.label));
    inspector.appendChild(head);

    const rows = [
      ['Canal', channel.name],
      ['Inicio', formatTime(clip.at)],
      ['Duración', `${Sequencer.clipDurationMs(clip)} ms`],
      ['Color', `rgb(${quantized.r}, ${quantized.g}, ${quantized.b})`],
      ['Comando', clip.effect.mode === 'configurable' ? '9 bytes' : 'pulso corto'],
      ['Bytes', frame.encoded.map(IRFrame.hexByte).join(' ')],
    ];
    if (clip.effect.mode === 'configurable') {
      rows.splice(5, 0, [
        'Envolvente',
        `${IRFrame.TIMER_MS[clip.effect.attack || 0]} / ` +
          `${IRFrame.TIMER_MS[clip.effect.sustain || 0]} / ` +
          `${IRFrame.TIMER_MS[clip.effect.release || 0]} ms`,
      ]);
    }

    const list = el('dl', 'seq-fields');
    for (const [key, value] of rows) {
      list.appendChild(el('dt', null, key));
      list.appendChild(el('dd', null, value));
    }
    inspector.appendChild(list);

    const actions = el('div', 'seq-inspector-actions');
    const duplicate = el('button', 'btn btn-sm', 'Duplicar');
    duplicate.type = 'button';
    duplicate.addEventListener('click', () => {
      const copy = Sequencer.createClip({
        at: clip.at + Sequencer.clipDurationMs(clip),
        label: clip.label,
        effect: clip.effect,
        transmission: clip.transmission,
      });
      Sequencer.addClip(show, channel.id, copy);
      transport.invalidate();
      renderTimeline();
      select(copy.id);
    });
    actions.appendChild(duplicate);

    const remove = el('button', 'btn btn-sm', 'Eliminar');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteSelected());
    actions.appendChild(remove);

    inspector.appendChild(actions);
  }

  function deleteSelected() {
    if (!view.selectedClipId) return;
    Sequencer.removeClip(show, view.selectedClipId);
    view.selectedClipId = null;
    transport.invalidate();
    renderTimeline();
    renderInspector();
  }

  // ------------------------------------------------------------ añadir clip

  function addCurrentCommand(channelId, at) {
    const command = bridge.currentCommand();
    const clip = Sequencer.createClip({
      at,
      label: command.label,
      effect: command.effect,
      transmission: command.transmission,
    });
    Sequencer.addClip(show, channelId, clip);
    transport.invalidate();
    renderTimeline();
    select(clip.id);
  }

  // ------------------------------------------------------------- despacho

  function handleDispatch(event) {
    flashLed(event.channelId, event.clip);
    appendLog(event);
  }

  /*
   * El punto de cada canal se enciende con el color del clip y se apaga solo:
   * es la única señal de que "algo se envió", ya que nada sale del navegador.
   */
  function flashLed(channelId, clip) {
    const led = heads.querySelector(`[data-led="${channelId}"]`);
    if (!led) return;
    const quantized = IRFrame.quantizeColor(clip.effect.color);
    led.style.transition = 'none';
    led.style.background = cssColor(quantized);
    led.style.boxShadow = `0 0 14px ${cssColor(quantized)}`;
    requestAnimationFrame(() => {
      const ms = Math.min(1200, Sequencer.clipDurationMs(clip));
      led.style.transition = `background ${ms}ms ease-out, box-shadow ${ms}ms ease-out`;
      led.style.background = '';
      led.style.boxShadow = '';
    });
  }

  function appendLog(event) {
    const row = el('li', 'seq-log-row');
    if (!event.result.ok) row.classList.add('is-error');

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
        event.result.ok
          ? event.result.frame.encoded.map(IRFrame.hexByte).join(' ')
          : event.result.error,
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

  function frame(now) {
    const state = transport.advance(now);
    if (state.playing) {
      $('seq-time').textContent = formatTime(state.cursor);
      playhead.style.transform = `translateX(${msToPx(state.cursor)}px)`;
      keepPlayheadVisible(state.cursor);
    }
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

  function exportFrames(formatKey) {
    const entries = Sequencer.toExportEntries(show);
    if (!entries.length) {
      bridge.toast('El show está vacío');
      return;
    }
    Exporters.download(formatKey, entries, `${Exporters.slug(show.name || 'show')}-show`);
    bridge.toast(`Descargando ${entries.length} comandos`);
  }

  // --------------------------------------------------------------- pintado

  function renderTimeline() {
    renderRuler();
    renderChannels();
  }

  function renderAll() {
    renderTimeline();
    renderInspector();
    renderTransportState(transport.state());
  }

  // ---------------------------------------------------------------- eventos

  $('seq-play').addEventListener('click', () => {
    if (transport.state().playing) transport.pause();
    else transport.play();
  });

  $('seq-stop').addEventListener('click', () => {
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
  });

  $('seq-transmitter').addEventListener('change', event => {
    transmitter = transmitters[event.target.value] || transmitters.emulado;
    transport.setTransmitter(transmitter);
  });

  $('seq-add-channel').addEventListener('click', () => {
    show.channels.push(Sequencer.createChannel({ name: `Canal ${show.channels.length + 1}` }));
    transport.invalidate();
    renderTimeline();
  });

  $('seq-clear-log').addEventListener('click', () => {
    logList.textContent = '';
  });

  $('seq-export-show').addEventListener('click', exportShow);
  $('seq-export-frames').addEventListener('change', event => {
    if (!event.target.value) return;
    exportFrames(event.target.value);
    event.target.value = '';
  });

  $('seq-name').addEventListener('change', event => {
    show.name = event.target.value.trim() || 'Show sin título';
  });

  // Mover el cabezal pulsando en la regla.
  ruler.addEventListener('pointerdown', event => {
    transport.seek(Math.max(0, pxToMs(event.offsetX)));
  });

  /*
   * Los atajos solo actúan cuando el foco está dentro del secuenciador y no en
   * un campo de texto: si no, escribir el nombre de un canal borraría clips.
   */
  document.addEventListener('keydown', event => {
    if (root.hidden || !view.selectedClipId) return;
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
    }
  });

  renderAll();
  requestAnimationFrame(frame);
})();
