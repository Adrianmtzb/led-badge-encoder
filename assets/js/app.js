/* Interfaz. Todo el cálculo ocurre en el navegador; no hay red. */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const SAMPLE_CAPTURE =
    '0000 006D 000C 0000 001B 001B 001B 0035 001B 0035 0035 006A ' +
    '001B 0050 0035 001B 001B 001B 001B 001B 001B 001B 0035 0050 0035 006A 001B 076C';

  const state = {
    color: { r: 240, g: 80, b: 0 },
    mode: 'short',
    attack: 1,
    sustain: 3,
    release: 2,
    chance: 0,
    restrictGroupId: 0,
    onStart: false,
    useGlobalSustain: false,
    repeatEnabled: false,
  };

  const transmission = {
    timing: 'capture',
    freqWord: IRFrame.FREQ_WORD_38K,
    cellUs: IRFrame.CELL_US_NOMINAL,
    gapUs: 50000,
    repeats: 1,
    includeSeparator: false,
  };

  let current = null;
  let currentName = 'ir-frame';   // nombre de archivo
  let currentLabel = 'pixmob';  // nombre del comando dentro del archivo

  // -------------------------------------------------------------- utilidades

  const toHex = ({ r, g, b }) =>
    '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  const parseHex = text => {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(text).trim());
    if (!match) return null;
    const value = parseInt(match[1], 16);
    return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
  };

  const cssColor = ({ r, g, b }) => `rgb(${r} ${g} ${b})`;

  const formatMs = us =>
    us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${Math.round(us)} µs`;

  let toastTimer;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
  }

  // ------------------------------------------------------------------ tabs

  function selectTab(name) {
    /*
     * Acotado a la navegación de arriba: dentro de los paneles hay otros
     * conmutadores con `role="tab"` —el de ajustes del secuenciador— que no
     * gobiernan paneles de la página.
     */
    for (const button of document.querySelectorAll('.tabs > [role="tab"]')) {
      const active = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(active));
      $(`panel-${button.dataset.tab}`).hidden = !active;
    }
    if (name === 'presets') renderPresets();
  }

  document.querySelector('.tabs').addEventListener('click', event => {
    const button = event.target.closest('[role="tab"]');
    if (button) selectTab(button.dataset.tab);
  });

  /**
   * Un enlace a una ancla dentro de un panel oculto no hace nada: el navegador
   * no puede desplazarse hasta un elemento con display:none. Se abre antes la
   * pestaña que lo contiene y después se salta al destino.
   */
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;

    const id = decodeURIComponent(link.getAttribute('href').slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;

    event.preventDefault();

    const panel = target.closest('.panel');
    if (panel) {
      const tab = document.querySelector(`[aria-controls="${panel.id}"]`);
      if (tab) selectTab(tab.dataset.tab);
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Sin tabindex, un encabezado no recibe foco y el salto se pierde para
    // quien navega con teclado o lector de pantalla.
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    history.replaceState(null, '', `#${id}`);
  });

  // --------------------------------------------------------- sincronización

  function syncColorInputs(source) {
    const { r, g, b } = state.color;
    if (source !== 'picker') $('color-input').value = toHex(state.color);
    if (source !== 'hex') $('hex-input').value = toHex(state.color);
    if (source !== 'number') {
      $('r-input').value = r;
      $('g-input').value = g;
      $('b-input').value = b;
    }
    if (source !== 'range') {
      $('r-range').value = r;
      $('g-range').value = g;
      $('b-range').value = b;
    }
  }

  function setColor(color, source) {
    state.color = {
      r: IRFrame.clamp8(color.r),
      g: IRFrame.clamp8(color.g),
      b: IRFrame.clamp8(color.b),
    };
    syncColorInputs(source);
    render();
  }

  $('color-input').addEventListener('input', event => {
    const color = parseHex(event.target.value);
    if (color) setColor(color, 'picker');
  });

  $('hex-input').addEventListener('input', event => {
    const color = parseHex(event.target.value);
    if (color) setColor(color, 'hex');
  });

  for (const channel of ['r', 'g', 'b']) {
    $(`${channel}-input`).addEventListener('input', event => {
      setColor({ ...state.color, [channel]: Number(event.target.value) }, 'number');
    });
    $(`${channel}-range`).addEventListener('input', event => {
      setColor({ ...state.color, [channel]: Number(event.target.value) }, 'range');
    });
  }

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      state.mode = radio.value;
      $('configurable-fields').hidden = state.mode !== 'configurable';
      render();
    });
  }

  const bindRange = (id, key, target = state) => {
    $(id).addEventListener('input', event => {
      target[key] = Number(event.target.value);
      render();
    });
  };

  bindRange('attack', 'attack');
  bindRange('sustain', 'sustain');
  bindRange('release', 'release');
  bindRange('chance', 'chance');
  bindRange('group', 'restrictGroupId');
  bindRange('repeats', 'repeats', transmission);

  const bindCheck = (id, key, target = state) => {
    $(id).addEventListener('change', event => {
      target[key] = event.target.checked;
      render();
    });
  };

  bindCheck('onstart', 'onStart');
  bindCheck('gsten', 'useGlobalSustain');
  bindCheck('rpen', 'repeatEnabled');
  bindCheck('separator', 'includeSeparator', transmission);

  $('gap').addEventListener('input', event => {
    transmission.gapUs = Number(event.target.value) * 1000;
    render();
  });

  $('timing').addEventListener('change', event => {
    transmission.timing = event.target.value;
    render();
  });

  $('freq').addEventListener('change', event => {
    transmission.freqWord = Number(event.target.value);
    render();
  });

  // ------------------------------------------------------------ copiar

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const text = $(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiado al portapapeles');
    } catch {
      toast('El navegador bloqueó el portapapeles');
    }
  });

  document.querySelector('.downloads').addEventListener('click', event => {
    const button = event.target.closest('[data-download]');
    if (!button || !current) return;
    try {
      Exporters.download(
        button.dataset.download,
        [{ name: currentLabel, result: current }],
        currentName,
      );
      toast(`Descargando .${Exporters.FORMATS[button.dataset.download].ext}`);
    } catch (error) {
      toast(error.message);
    }
  });

  // ------------------------------------------------------------- dibujos

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const svgNode = (tag, attrs, text) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    if (text != null) node.textContent = text;
    return node;
  };

  /**
   * Dibuja el envolvente attack/sustain/release con su escala temporal:
   * guías en cada frontera, marcas de tiempo acumulado y tramos etiquetados.
   * El eje es lineal en milisegundos, así que la anchura de cada tramo es
   * proporcional a su duración real.
   */
  function drawEnvelope() {
    const svg = $('envelope');
    svg.textContent = '';
    if (state.mode !== 'configurable') return;

    const a = IRFrame.TIMER_MS[state.attack];
    const s = IRFrame.TIMER_MS[state.sustain];
    const r = IRFrame.TIMER_MS[state.release];
    const total = a + s + r;

    const W = 320;
    const padL = 10;
    const padR = 10;
    const top = 16;      // nivel de brillo máximo
    const bottom = 74;   // línea de base
    const tickY = 88;    // fila de tiempos acumulados
    const spanY = 106;   // fila de tramos A/S/R
    const usable = W - padL - padR;

    // Con los tres tiempos a cero no hay escala posible: se dibuja un pico
    // simbólico para que el gráfico no quede vacío.
    const flat = total === 0;
    const scale = flat ? 0 : usable / total;
    const x0 = padL;
    const xa = flat ? padL + 4 : padL + a * scale;
    const xs = flat ? padL + 8 : xa + s * scale;
    const xr = flat ? padL + 12 : xs + r * scale;

    const color = cssColor(IRFrame.quantizeColor(state.color));

    // Guía del nivel máximo, para que se lea que el tramo plano es el sostén.
    svg.appendChild(
      svgNode('line', {
        x1: padL, x2: W - padR, y1: top, y2: top,
        stroke: 'currentColor', 'stroke-opacity': 0.18,
        'stroke-dasharray': '2 3',
      }),
    );

    // Guías verticales en cada frontera de tramo.
    for (const x of [xa, xs, xr]) {
      svg.appendChild(
        svgNode('line', {
          x1: x, x2: x, y1: top, y2: bottom,
          stroke: 'currentColor', 'stroke-opacity': 0.22,
          'stroke-dasharray': '2 3',
        }),
      );
    }

    svg.appendChild(
      svgNode('path', {
        d: `M ${x0} ${bottom} L ${xa} ${top} L ${xs} ${top} L ${xr} ${bottom} Z`,
        fill: color,
        'fill-opacity': 0.32,
        stroke: color,
        'stroke-width': 1.5,
        'stroke-linejoin': 'round',
      }),
    );

    // Eje temporal.
    svg.appendChild(
      svgNode('line', {
        x1: padL, x2: W - padR, y1: bottom, y2: bottom,
        stroke: 'currentColor', 'stroke-opacity': 0.35,
      }),
    );

    // Marcas de tiempo acumulado. Se omite la que colisione con la anterior.
    const marks = [
      { x: x0, ms: 0 },
      { x: xa, ms: a },
      { x: xs, ms: a + s },
      { x: xr, ms: total },
    ];
    // La última marca lleva la unidad, en lugar de una etiqueta "ms" suelta
    // que chocaba con el eje cuando el tramo final era estrecho.
    let lastTick = null;
    let lastTickX = -Infinity;
    marks.forEach((mark, index) => {
      svg.appendChild(
        svgNode('line', {
          x1: mark.x, x2: mark.x, y1: bottom, y2: bottom + 4,
          stroke: 'currentColor', 'stroke-opacity': 0.35,
        }),
      );

      const isLast = index === marks.length - 1;
      if (flat && !isLast && index !== 0) return;

      const label = flat
        ? index === 0
          ? '0 ms'
          : null
        : isLast
          ? `${mark.ms} ms`
          : `${mark.ms}`;
      if (label == null) return;

      // El total es la cifra clave: si no cabe junto a la marca anterior, se
      // retira la anterior en vez de omitir el total.
      const crowded = mark.x - lastTickX < 30;
      if (crowded && !isLast) return;
      if (crowded && isLast && lastTick) lastTick.remove();

      lastTickX = mark.x;
      lastTick = svgNode(
        'text',
        {
          x: Math.min(Math.max(mark.x, padL), W - padR),
          y: tickY,
          'text-anchor': index === 0 ? 'start' : isLast ? 'end' : 'middle',
          'font-size': 9,
          fill: 'currentColor',
          'fill-opacity': 0.55,
        },
        label,
      );
      svg.appendChild(lastTick);
    });

    // Tramos etiquetados bajo el eje. El nombre se conserva mientras quepa,
    // porque sin él la cifra no dice a qué fase pertenece.
    const spans = [
      { from: x0, to: xa, name: 'attack', ms: a },
      { from: xa, to: xs, name: 'sustain', ms: s },
      { from: xs, to: xr, name: 'release', ms: r },
    ];
    for (const span of spans) {
      const width = span.to - span.from;
      if (flat || width < 11) continue;

      svg.appendChild(
        svgNode('line', {
          x1: span.from + 1, x2: span.to - 1, y1: spanY - 7, y2: spanY - 7,
          stroke: 'currentColor', 'stroke-opacity': 0.3,
        }),
      );

      const initial = span.name[0].toUpperCase();
      const text =
        width >= 72
          ? `${span.name} ${span.ms} ms`
          : width >= 40
            ? `${initial} ${span.ms} ms`
            : width >= 24
              ? `${initial} ${span.ms}`
              : initial;

      svg.appendChild(
        svgNode(
          'text',
          {
            x: (span.from + span.to) / 2, y: spanY + 2, 'text-anchor': 'middle',
            'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.6,
          },
          text,
        ),
      );
    }

    // Notas de las excepciones documentadas que cambian lo que se ve arriba.
    const notes = [];
    if (state.sustain === 7 && state.release !== 0) {
      notes.push('sustain=111 con release≠0 toma el valor del GST guardado');
    }
    if (state.release === 0) {
      notes.push('release=000 activa una lógica especial aún bajo investigación');
    }
    if (state.useGlobalSustain) {
      notes.push('gsten activo: el sostén puede venir del GST del dispositivo');
    }

    $('envelope-hint').textContent = flat
      ? 'Los tres tiempos a cero: el badge apenas registra un destello.'
      : `Duración total ≈ ${total} ms (${a} + ${s} + ${r})` +
        (notes.length ? `. Ojo: ${notes.join('; ')}.` : '.');
  }

  /** Dibuja el bitstream como onda cuadrada. */
  function drawWaveform(bits) {
    const svg = $('waveform');
    svg.textContent = '';
    if (!bits.length) return;

    const W = 600;
    const H = 60;
    const top = 10;
    const bottom = H - 10;
    const step = W / bits.length;

    let d = `M 0 ${bits[0] ? top : bottom}`;
    let x = 0;
    for (let i = 0; i < bits.length; i++) {
      const y = bits[i] ? top : bottom;
      d += ` L ${x.toFixed(2)} ${y}`;
      x += step;
      d += ` L ${x.toFixed(2)} ${y}`;
    }

    const ns = 'http://www.w3.org/2000/svg';
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', cssColor(IRFrame.quantizeColor(state.color)));
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);
  }

  /** Etiqueta cada byte lógico con el campo que representa. */
  function drawByteMap(logical) {
    const container = $('bytemap');
    container.textContent = '';
    const labels =
      logical.length >= 9
        ? ['magic', 'checksum', 'flags', 'verde', 'rojo', 'azul', 'atk/chance', 'rel/sus', 'rpen/grupo']
        : ['magic', 'checksum', 'flags', 'verde', 'rojo', 'azul'];

    logical.forEach((byte, index) => {
      const cell = el('div');
      // El checksum lógico es un hueco: su valor real solo existe codificado.
      const value = index === 1 ? '··' : IRFrame.hexByte(byte);
      cell.appendChild(el('b', null, value));
      cell.appendChild(el('span', null, labels[index] || `0x${IRFrame.hexByte(index)}`));
      container.appendChild(cell);
    });
  }

  // -------------------------------------------------------------- render

  function render() {
    // Etiquetas de los controles
    $('attack-label').textContent = `${IRFrame.TIMER_MS[state.attack]} ms`;
    $('sustain-label').textContent = `${IRFrame.TIMER_MS[state.sustain]} ms`;
    $('release-label').textContent = `${IRFrame.TIMER_MS[state.release]} ms`;
    $('chance-label').textContent = `${IRFrame.CHANCE_PCT[state.chance]} %`;
    $('group-label').textContent =
      state.restrictGroupId === 0 ? 'broadcast' : `id ${state.restrictGroupId}`;
    $('repeats-label').textContent = String(transmission.repeats);
    $('gap-label').textContent = `${(transmission.gapUs / 1000).toFixed(1)} ms`;

    $('mode-hint').textContent =
      state.mode === 'short'
        ? 'Seis bytes. El badge aplica su propia temporización: attack 0 ms, release inicial 32 ms y después 384 ms. De ahí el destello de casi medio segundo.'
        : 'Nueve bytes. Controlas attack, sustain, release, probabilidad y grupo. Es la vía recomendada para efectos nuevos.';

    // Color solicitado frente a color realmente transmitido
    const quantized = IRFrame.quantizeColor(state.color);
    $('swatch-requested').style.background = cssColor(state.color);
    $('swatch-actual').style.background = cssColor(quantized);
    $('requested-rgb').textContent =
      `${state.color.r}, ${state.color.g}, ${state.color.b}`;
    $('actual-rgb').textContent = `${quantized.r}, ${quantized.g}, ${quantized.b}`;

    const drift =
      Math.abs(state.color.r - quantized.r) +
      Math.abs(state.color.g - quantized.g) +
      Math.abs(state.color.b - quantized.b);
    $('quantize-hint').textContent = drift
      ? `El badge recibe solo 6 bits por canal, así que cada valor baja al múltiplo de 4 inferior. Aquí se pierden ${drift} niveles en total.`
      : 'Este color cae exacto en la rejilla de 6 bits por canal: no se pierde nada.';

    // Codificación
    let result;
    try {
      result = IRFrame.encodeEffect({ ...state }, { ...transmission });
    } catch (error) {
      $('pronto-out').textContent = `Error: ${error.message}`;
      return;
    }
    current = result;
    currentName = `ir-frame-${toHex(quantized).slice(1).toLowerCase()}`;
    currentLabel = `rgb(${quantized.r},${quantized.g},${quantized.b})`;

    $('pronto-out').textContent = result.pronto;
    $('logical-out').textContent = result.logical.map(IRFrame.hexByte).join(' ');
    $('encoded-out').textContent = result.encoded.map(IRFrame.hexByte).join(' ');
    $('bits-out').textContent = result.bits.join('');

    const stats = $('stats');
    stats.textContent = '';
    const entries = [
      ['Bytes', `${result.encoded.length}`],
      ['Bits', `${result.bits.length}`],
      ['Pares', `${result.durations.length / 2}`],
      ['Portadora', `${(result.carrierHz / 1000).toFixed(1)} kHz`],
      ['Duración', formatMs(result.totalUs)],
      ['Checksum', `0x${IRFrame.hexByte(result.encoded[1])}`],
    ];
    for (const [label, value] of entries) {
      const group = el('div');
      group.appendChild(el('dt', null, label));
      group.appendChild(el('dd', null, value));
      stats.appendChild(group);
    }

    drawByteMap(result.logical);
    drawWaveform(result.bits);
    drawEnvelope();
  }

  // ------------------------------------------------------------- presets

  let presetsRendered = false;

  function applyPreset(item) {
    Object.assign(state, presetToEffect(item));
    syncColorInputs();
    $('attack').value = state.attack;
    $('sustain').value = state.sustain;
    $('release').value = state.release;
    $('chance').value = state.chance;
    $('group').value = state.restrictGroupId;
    $('onstart').checked = state.onStart;
    $('gsten').checked = state.useGlobalSustain;
    $('rpen').checked = state.repeatEnabled;
    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.checked = radio.value === state.mode;
    }
    $('configurable-fields').hidden = state.mode !== 'configurable';
    render();
    selectTab('generador');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast(`Cargado: ${item.name}`);
  }

  function renderPresets() {
    if (presetsRendered) return;
    presetsRendered = true;

    const root = $('preset-categories');
    for (const category of PRESETS) {
      const section = el('section', 'preset-cat');

      const header = el('header');
      const heading = el('div');
      heading.appendChild(el('h2', null, category.name));
      heading.appendChild(el('p', null, category.blurb));
      header.appendChild(heading);

      const actions = el('div', 'actions');
      for (const key of Object.keys(Exporters.FORMATS)) {
        const button = el('button', 'btn btn-sm', `.${Exporters.FORMATS[key].ext}`);
        button.addEventListener('click', () => {
          const entries = category.items.map(item => ({
            name: item.name,
            note: item.note,
            result: IRFrame.encodeEffect(presetToEffect(item), { ...transmission }),
          }));
          Exporters.download(key, entries, `ir-frame-${category.id}`);
          toast(`Descargando ${category.items.length} comandos`);
        });
        actions.appendChild(button);
      }
      header.appendChild(actions);
      section.appendChild(header);

      const grid = el('div', 'preset-grid');
      for (const item of category.items) {
        const [r, g, b] = item.color;
        const quantized = IRFrame.quantizeColor({ r, g, b });

        const button = el('button', 'preset');
        button.type = 'button';

        const chip = el('div', 'chip');
        chip.style.background = cssColor(quantized);
        button.appendChild(chip);

        const meta = el('div', 'meta');
        meta.appendChild(el('div', 'name', item.name));
        meta.appendChild(
          el('div', 'sub', `${quantized.r}, ${quantized.g}, ${quantized.b}`),
        );
        if (item.note) meta.appendChild(el('div', 'note', item.note));
        button.appendChild(meta);

        button.addEventListener('click', () => applyPreset(item));
        grid.appendChild(button);
      }
      section.appendChild(grid);
      root.appendChild(section);
    }
  }

  // ---------------------------------------------------------- analizador

  function renderAnalysis(text) {
    const output = $('analyzer-output');
    output.textContent = '';

    let analysis;
    try {
      analysis = IRFrame.analyzePronto(text);
    } catch (error) {
      const badge = el('span', 'verdict err', 'No se pudo leer');
      output.appendChild(badge);
      output.appendChild(el('p', 'hint', error.message));
      return;
    }

    const { parsed, signal, best, status } = analysis;
    const verdictClass = status === 'válido' ? 'ok' : status === 'plausible' ? 'warn' : 'err';
    output.appendChild(el('span', `verdict ${verdictClass}`, status));

    const kv = el('dl', 'kv');
    const add = (key, value) => {
      kv.appendChild(el('dt', null, key));
      kv.appendChild(el('dd', null, value));
    };

    add('Portadora', `${(parsed.carrierHz / 1000).toFixed(2)} kHz (0x${IRFrame.hexWord(parsed.freqWord)})`);
    add('Pares', `${parsed.introPairs} intro + ${parsed.repeatPairs} repetible`);
    add('Celda T estimada', `${(signal.cellUnits * parsed.unitUs).toFixed(1)} µs`);
    add('Gap final', signal.gapUnits ? formatMs(signal.gapUs) : 'ninguno');
    add('Error de redondeo', `${(signal.residual * 100).toFixed(1)} % por run`);
    add('Bits', `${signal.bits.length}`);
    add('Bitstream', signal.bits.join(''));

    if (best && best.status === 'válido') {
      add('Bytes', best.bytes.map(IRFrame.hexByte).join(' '));
      add('Padding', `${best.lead} ceros delante, ${best.tail} detrás`);
      add('Checksum', 'coincide');

      const info = best.info;
      add('Comando', `${info.length} bytes · type ${info.typeBits}`);

      if (info.color) {
        const dd = el('dd');
        const chip = el('span', 'result-swatch');
        chip.style.background = cssColor(info.color);
        dd.appendChild(chip);
        dd.appendChild(document.createTextNode(`rgb(${info.color.r}, ${info.color.g}, ${info.color.b})`));
        kv.appendChild(el('dt', null, 'Color'));
        kv.appendChild(dd);
      }

      if (info.length >= 9) {
        add('Attack', `${IRFrame.TIMER_MS[info.attack]} ms`);
        add('Sustain', `${IRFrame.TIMER_MS[info.sustain]} ms`);
        add('Release', `${IRFrame.TIMER_MS[info.release]} ms`);
        add('Probabilidad', `${IRFrame.CHANCE_PCT[info.chance]} %`);
        add('Grupo', info.restrictGroupId === 0 ? 'broadcast' : String(info.restrictGroupId));
      }
      add('Flags', `on-start ${info.onStart ? 'sí' : 'no'} · gsten ${info.useGlobalSustain ? 'sí' : 'no'}`);
    } else if (best) {
      add('Mejor candidato', best.bytes.map(IRFrame.hexByte).join(' '));
      add('Motivo', best.error || 'sin estructura reconocible');
    }

    output.appendChild(kv);

    if (status === 'plausible') {
      output.appendChild(
        el(
          'p',
          'hint',
          'La estructura y el checksum cuadran, pero los tiempos se desvían bastante de la celda estimada. Puede ser ruido de captura.',
        ),
      );
    } else if (status === 'desconocido') {
      output.appendChild(
        el(
          'p',
          'hint',
          'Ningún alineamiento produce un frame de 6 o 9 bytes con magic 0x80 y checksum válido. Puede ser otro protocolo, otra generación de hardware o una captura incompleta.',
        ),
      );
    }
  }

  $('analyze-btn').addEventListener('click', () => {
    renderAnalysis($('analyzer-input').value);
  });

  $('analyze-sample').addEventListener('click', () => {
    $('analyzer-input').value = SAMPLE_CAPTURE;
    renderAnalysis(SAMPLE_CAPTURE);
  });

  // ------------------------------------------------------------ protocolo

  function renderTimingTable() {
    const body = $('timing-table');
    for (let key = 0; key < 8; key++) {
      const row = el('tr');
      row.appendChild(el('td', null, key.toString(2).padStart(3, '0')));
      row.appendChild(el('td', null, `${IRFrame.TIMER_MS[key]} ms`));
      row.appendChild(el('td', null, key.toString(2).padStart(3, '0')));
      row.appendChild(el('td', null, `${IRFrame.CHANCE_PCT[key]} %`));
      body.appendChild(row);
    }
  }

  /** Comprobaciones contra los vectores conocidos, ejecutadas en cada carga. */
  function runSelfTest() {
    const checks = [];
    const check = (name, fn) => {
      try {
        const detail = fn();
        checks.push({ name, ok: true, detail });
      } catch (error) {
        checks.push({ name, ok: false, detail: error.message });
      }
    };

    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };

    check('Vector oficial rgb(0, 252, 192)', () => {
      const bytes = IRFrame.encodeLogical(
        IRFrame.buildSingleColor({ color: { r: 0, g: 252, b: 192 } }),
      );
      const hex = bytes.map(IRFrame.hexByte).join(' ');
      assert(hex === '80 5A 21 26 21 5A', `obtenido ${hex}`);
      return hex;
    });

    check('Bitstream oficial de 40 bits', () => {
      const bytes = IRFrame.encodeLogical(
        IRFrame.buildSingleColor({ color: { r: 0, g: 252, b: 192 } }),
      );
      const bits = IRFrame.trimZeros(IRFrame.bytesToBits(bytes)).join('');
      assert(bits === '1010110101000010001100100100001000101101', `obtenido ${bits}`);
      return `${bits.length} bits`;
    });

    check('Tabla de sustitución reversible y única', () => {
      assert(new Set(IRFrame.TABLE).size === 64, 'hay valores repetidos');
      assert(
        IRFrame.TABLE.every((value, index) => IRFrame.INVERSE.get(value) === index),
        'la inversa no coincide',
      );
      return '64 entradas';
    });

    check('Trama documentada P_PULSO_00 reproducida', () => {
      const generated = IRFrame.encodeEffect(
        { color: { r: 240, g: 32, b: 0 }, mode: 'short' },
        { timing: 'capture', freqWord: IRFrame.FREQ_WORD_38K, gapUs: 49960 },
      );
      assert(generated.pronto === SAMPLE_CAPTURE, 'la salida difiere de la captura');
      return `${generated.durations.length} duraciones idénticas`;
    });

    check('Ida y vuelta de un comando de 9 bytes', () => {
      const effect = {
        color: { r: 132, g: 200, b: 64 },
        mode: 'configurable',
        attack: 3,
        sustain: 5,
        release: 2,
        chance: 6,
        restrictGroupId: 17,
      };
      const encoded = IRFrame.encodeEffect(effect, {});
      const info = IRFrame.describeLogical(IRFrame.decodeEncoded(encoded.encoded));
      assert(info.attack === 3 && info.sustain === 5 && info.release === 2, 'tiempos alterados');
      assert(info.chance === 6 && info.restrictGroupId === 17, 'chance o grupo alterados');
      assert(info.color.r === 132 && info.color.g === 200 && info.color.b === 64, 'color alterado');
      return 'todos los campos conservados';
    });

    check('Un byte alterado invalida el frame', () => {
      const bytes = IRFrame.encodeLogical(
        IRFrame.buildSingleColor({ color: { r: 10, g: 20, b: 30 } }),
      );
      bytes[3] = (bytes[3] + 1) & 0xff;
      let threw = false;
      try {
        IRFrame.decodeEncoded(bytes);
      } catch {
        threw = true;
      }
      assert(threw, 'el frame corrupto pasó la validación');
      return 'detectado';
    });

    const container = $('selftest');
    const passed = checks.filter(c => c.ok).length;
    container.appendChild(
      el(
        'p',
        'hint',
        `${passed} de ${checks.length} comprobaciones pasan en este navegador.`,
      ),
    );
    const list = el('ul');
    for (const item of checks) {
      const li = el('li', item.ok ? 'pass' : 'fail');
      li.appendChild(el('span', 'mark', item.ok ? '✓' : '✕'));
      const text = el('span');
      text.appendChild(document.createTextNode(item.name + ' '));
      text.appendChild(el('span', 'detail', item.detail || ''));
      li.appendChild(text);
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  /*
   * Puente para el secuenciador, que vive en otro archivo y necesita saber qué
   * comando hay ahora mismo en el generador. Se expone lo mínimo y siempre como
   * copia, para que nadie mute el estado del generador desde fuera.
   */
  window.GeneratorBridge = {
    currentCommand: () => ({
      label: currentLabel,
      effect: { ...state, color: { ...state.color } },
      transmission: { ...transmission },
    }),
    toast,
  };

  // --------------------------------------------------------------- arranque

  renderTimingTable();
  runSelfTest();

  // Entrar directamente con un hash (…/#creditos) debe abrir su pestaña.
  if (location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const panel = target && target.closest('.panel');
    if (panel) {
      const tab = document.querySelector(`[aria-controls="${panel.id}"]`);
      if (tab) selectTab(tab.dataset.tab);
      target.scrollIntoView({ block: 'start' });
    }
  }

  syncColorInputs();
  render();
})();
