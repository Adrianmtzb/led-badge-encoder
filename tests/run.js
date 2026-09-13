#!/usr/bin/env node
/*
 * Suite de verificación del protocolo. Sin dependencias: `node tests/run.js`.
 *
 * El criterio es que ninguna aportación pueda romper en silencio la
 * codificación. Los vectores publicados en la documentación del protocolo son
 * innegociables: si uno falla, la salida ya no es compatible con el hardware.
 *
 * Los módulos del navegador se cargan con `new Function` porque son scripts
 * clásicos sin exports; así se prueban exactamente los mismos archivos que
 * sirve la web, sin duplicar código ni añadir un paso de build.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function load(file, expression) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return new Function(`${source}\n;return ${expression};`)();
}

const IRFrame = load('assets/js/protocol.js', 'IRFrame');
const { PRESETS, presetToEffect } = load(
  'assets/js/presets.js',
  '({ PRESETS, presetToEffect })',
);

// Los exportadores usan IRFrame como global, igual que en el navegador.
globalThis.IRFrame = IRFrame;
const Exporters = load('assets/js/exporters.js', 'Exporters');
const Sequencer = load('assets/js/sequencer.js', 'Sequencer');

// ---------------------------------------------------------------- harness

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const detail = fn();
    passed++;
    process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (error) {
    failures.push({ name, message: error.message });
    process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`);
  }
}

/*
 * El transmisor por HTTP responde con promesas, así que sus comprobaciones se
 * apuntan aquí y se ejecutan al final, en orden y una detrás de otra: el
 * informe sigue siendo una sola lista y el código de salida sigue siendo fiable.
 */
const asyncTests = [];

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    try {
      const detail = await fn();
      passed++;
      process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`);
    } catch (error) {
      failures.push({ name, message: error.message });
      process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`);
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: esperado ${expected}, obtenido ${actual}`);
  }
}

const hex = bytes => bytes.map(IRFrame.hexByte).join(' ');
const section = title => process.stdout.write(`\n${title}\n`);

// Trama tal y como la publican las fuentes del protocolo.
const P_PULSO_00 =
  '0000 006D 000C 0000 001B 001B 001B 0035 001B 0035 0035 006A ' +
  '001B 0050 0035 001B 001B 001B 001B 001B 001B 001B 0035 0050 0035 006A 001B 076C';

// ------------------------------------------------------- vectores oficiales

section('Vectores documentados');

test('rgb(0,252,192) produce 80 5A 21 26 21 5A', () => {
  const bytes = IRFrame.encodeLogical(
    IRFrame.buildSingleColor({ color: { r: 0, g: 252, b: 192 } }),
  );
  assertEqual(hex(bytes), '80 5A 21 26 21 5A', 'bytes codificados');
  return hex(bytes);
});

test('su bitstream recortado son los 40 bits documentados', () => {
  const bytes = IRFrame.encodeLogical(
    IRFrame.buildSingleColor({ color: { r: 0, g: 252, b: 192 } }),
  );
  const bits = IRFrame.trimZeros(IRFrame.bytesToBits(bytes)).join('');
  assertEqual(bits, '1010110101000010001100100100001000101101', 'bitstream');
  return `${bits.length} bits`;
});

test('la trama documentada P_PULSO_00 se reproduce word por word', () => {
  const generated = IRFrame.encodeEffect(
    { color: { r: 240, g: 32, b: 0 }, mode: 'short' },
    { timing: 'capture', gapUs: 49960 },
  );
  assertEqual(generated.pronto, P_PULSO_00, 'pronto');
  return `${generated.durations.length} duraciones`;
});

test('P_PULSO_00 decodifica a rgb(240, 32, 0)', () => {
  const analysis = IRFrame.analyzePronto(P_PULSO_00);
  assertEqual(analysis.status, 'válido', 'estado');
  const { r, g, b } = analysis.best.info.color;
  assert(r === 240 && g === 32 && b === 0, `color ${r}, ${g}, ${b}`);
  return 'checksum y estructura confirmados';
});

// -------------------------------------------------------------- sustitución

section('Tabla de sustitución y checksum');

test('los 64 valores de la tabla son únicos', () => {
  assertEqual(new Set(IRFrame.TABLE).size, 64, 'valores distintos');
  return '64 entradas';
});

test('la tabla inversa revierte cada valor', () => {
  for (let i = 0; i < 64; i++) {
    assertEqual(IRFrame.INVERSE.get(IRFrame.TABLE[i]), i, `índice ${i}`);
  }
  return 'inverse[TABLE[i]] === i';
});

test('alterar un byte codificado invalida el frame', () => {
  /*
   * El checksum descarta los dos bits bajos de la suma (`sum8 >> 2`), así que
   * solo cubre cambios que muevan los seis bits altos. Se corrompe con +4 —el
   * menor delta que siempre cruza ese umbral— en lugar de +1, que caería
   * dentro del mismo cubo y pasaría desapercibido. Es una limitación real del
   * protocolo, no del decodificador: el checksum detecta ruido, no es un CRC.
   */
  const bytes = IRFrame.encodeLogical(
    IRFrame.buildSingleColor({ color: { r: 10, g: 20, b: 30 } }),
  );
  for (let i = 1; i < bytes.length; i++) {
    const corrupted = [...bytes];
    corrupted[i] = (corrupted[i] + 4) & 0xff;
    let threw = false;
    try {
      IRFrame.decodeEncoded(corrupted);
    } catch {
      threw = true;
    }
    assert(threw, `el byte ${i} se corrompió sin detectarse`);
  }
  return `${bytes.length - 1} bytes`;
});

test('el magic 0x80 se exige en el primer byte', () => {
  const bytes = IRFrame.encodeLogical(
    IRFrame.buildSingleColor({ color: { r: 10, g: 20, b: 30 } }),
  );
  let threw = false;
  try {
    IRFrame.decodeEncoded([0x81, ...bytes.slice(1)]);
  } catch {
    threw = true;
  }
  assert(threw, 'se aceptó un magic distinto de 0x80');
  return 'rechazado';
});

test('un valor lógico fuera de 0..63 se rechaza', () => {
  let threw = false;
  try {
    IRFrame.encodeLogical([0x80, 0x00, 0x40]);
  } catch {
    threw = true;
  }
  assert(threw, 'se aceptó un valor de más de 6 bits');
  return 'rechazado';
});

// ------------------------------------------------------------------ color

section('Color');

test('cada canal se cuantiza a channel & 0xFC', () => {
  for (let value = 0; value <= 255; value++) {
    const q = IRFrame.quantizeColor({ r: value, g: value, b: value });
    assertEqual(q.r, value & 0xfc, `canal ${value}`);
  }
  return '256 valores';
});

test('un color ida y vuelta conserva el valor cuantizado', () => {
  for (let value = 0; value < 256; value++) {
    const color = { r: value, g: 255 - value, b: (value * 3) % 256 };
    const result = IRFrame.encodeEffect({ color }, {});
    const analysis = IRFrame.analyzePronto(result.pronto);
    assertEqual(analysis.status, 'válido', `color ${value}`);
    const decoded = analysis.best.info.color;
    const expected = IRFrame.quantizeColor(color);
    assert(
      decoded.r === expected.r && decoded.g === expected.g && decoded.b === expected.b,
      `color ${value}: ${JSON.stringify(decoded)} != ${JSON.stringify(expected)}`,
    );
  }
  return 'barrido de 256 colores';
});

// -------------------------------------------------------------- estructura

section('Estructura de comandos');

test('el comando configurable conserva todos sus campos', () => {
  for (let key = 0; key < 8; key++) {
    const effect = {
      color: { r: 132, g: 200, b: 64 },
      mode: 'configurable',
      attack: key,
      sustain: (key + 3) % 8,
      release: (key + 5) % 8,
      chance: (key + 1) % 8,
      restrictGroupId: key * 4,
      repeatEnabled: key % 2 === 0,
      onStart: key % 3 === 0,
      useGlobalSustain: key % 4 === 0,
    };
    const encoded = IRFrame.encodeEffect(effect, {});
    const info = IRFrame.describeLogical(IRFrame.decodeEncoded(encoded.encoded));
    for (const field of [
      'attack', 'sustain', 'release', 'chance',
      'restrictGroupId', 'repeatEnabled', 'onStart', 'useGlobalSustain',
    ]) {
      assertEqual(info[field], effect[field], `${field} (key ${key})`);
    }
  }
  return '8 combinaciones';
});

test('el pulso corto son 6 bytes y el configurable 9', () => {
  const short = IRFrame.encodeEffect({ color: { r: 1, g: 2, b: 3 } }, {});
  const long = IRFrame.encodeEffect(
    { color: { r: 1, g: 2, b: 3 }, mode: 'configurable' }, {},
  );
  assertEqual(short.encoded.length, 6, 'pulso corto');
  assertEqual(long.encoded.length, 9, 'configurable');
  return '6 / 9';
});

test('los bits 7 y 6 son cero en todo byte lógico desde 0x02', () => {
  const result = IRFrame.encodeEffect(
    {
      color: { r: 255, g: 255, b: 255 },
      mode: 'configurable',
      attack: 7, sustain: 7, release: 7, chance: 7,
      restrictGroupId: 31, repeatEnabled: true,
      onStart: true, useGlobalSustain: true,
    },
    {},
  );
  for (let i = 2; i < result.logical.length; i++) {
    assert(
      (result.logical[i] & 0xc0) === 0,
      `byte ${i} vale 0x${IRFrame.hexByte(result.logical[i])}`,
    );
  }
  return 'todos los campos al máximo';
});

// ------------------------------------------------------------- bitstream

section('Bitstream y runs');

test('bytes -> bits -> bytes conserva los datos', () => {
  const bytes = [0x80, 0x5a, 0x21, 0x26, 0x21, 0x5a];
  const back = IRFrame.bitsToBytes(IRFrame.bytesToBits(bytes));
  assertEqual(back.join(','), bytes.join(','), 'ida y vuelta');
  return '6 bytes';
});

test('bits -> runs -> bits conserva la señal', () => {
  const bits = IRFrame.trimZeros(
    IRFrame.bytesToBits([0x80, 0x92, 0x21, 0x56, 0x8d, 0x21]),
  );
  const back = IRFrame.runsToBits(IRFrame.runLengthEncode(bits));
  assertEqual(back.join(''), bits.join(''), 'run-length');
  return `${bits.length} bits`;
});

test('el bitstream recortado empieza y acaba en 1', () => {
  for (let value = 0; value < 256; value += 7) {
    const result = IRFrame.encodeEffect({ color: { r: value, g: 0, b: 0 } }, {});
    assertEqual(result.bits[0], 1, `primer bit (r=${value})`);
    assertEqual(result.bits[result.bits.length - 1], 1, `último bit (r=${value})`);
  }
  return 'sin ceros en los extremos';
});

// ----------------------------------------------------------------- pronto

section('Pronto Hex');

test('la cabecera declara exactamente los pares presentes', () => {
  for (const repeats of [1, 2, 5]) {
    for (const includeSeparator of [false, true]) {
      const result = IRFrame.encodeEffect(
        { color: { r: 200, g: 100, b: 50 } },
        { repeats, includeSeparator },
      );
      const words = result.pronto.split(' ').map(w => parseInt(w, 16));
      assertEqual(result.durations.length % 2, 0, 'duraciones pares');
      assertEqual(
        (words[2] + words[3]) * 2,
        result.durations.length,
        `pares (repeats=${repeats}, sep=${includeSeparator})`,
      );
      assertEqual(words.length, 4 + result.durations.length, 'longitud total');
    }
  }
  return 'repeticiones y separador';
});

test('serializar y parsear conserva las duraciones', () => {
  const result = IRFrame.encodeEffect({ color: { r: 12, g: 34, b: 56 } }, {});
  const parsed = IRFrame.parsePronto(result.pronto);
  assertEqual(parsed.durations.join(','), result.durations.join(','), 'duraciones');
  assertEqual(parsed.freqWord, IRFrame.FREQ_WORD_38K, 'divisor');
  return `${parsed.durations.length} duraciones`;
});

test('la temporización nominal también decodifica', () => {
  const result = IRFrame.encodeEffect(
    { color: { r: 0, g: 252, b: 192 } },
    { timing: 'nominal' },
  );
  const analysis = IRFrame.analyzePronto(result.pronto);
  assertEqual(analysis.status, 'válido', 'estado');
  return 'celda 694.44 µs';
});

test('el parser rechaza cabeceras inválidas', () => {
  const cases = [
    ['0000', 'faltan words'],
    ['0000 006D 0001 0000 001B', 'cuenta declarada distinta'],
    ['0000 0000 0001 0000 001B 001B', 'divisor cero'],
    ['0000 006D 0001 0000 XXXX 001B', 'word no hexadecimal'],
    ['0100 006D 0001 0000 001B 001B', 'formato no soportado'],
  ];
  for (const [input, reason] of cases) {
    let threw = false;
    try {
      IRFrame.parsePronto(input);
    } catch {
      threw = true;
    }
    assert(threw, `se aceptó: ${reason}`);
  }
  return `${cases.length} casos rechazados`;
});

// ---------------------------------------------------------------- presets

section('Presets');

test('los 25 colores P_PULSO decodifican a su RGB documentado', () => {
  const captures = PRESETS.find(c => c.id === 'documentados');
  assertEqual(captures.items.length, 25, 'número de colores documentados');
  for (const item of captures.items) {
    const effect = presetToEffect(item);
    const result = IRFrame.encodeEffect(effect, {});
    const analysis = IRFrame.analyzePronto(result.pronto);
    assertEqual(analysis.status, 'válido', `${item.name}`);
    const decoded = analysis.best.info.color;
    const [r, g, b] = item.color;
    assert(
      decoded.r === r && decoded.g === g && decoded.b === b,
      `${item.name}: ${JSON.stringify(decoded)} != ${r},${g},${b}`,
    );
  }
  return '25 colores';
});

test('todo preset codifica y vuelve a decodificarse', () => {
  let count = 0;
  for (const category of PRESETS) {
    for (const item of category.items) {
      const effect = presetToEffect(item);
      const result = IRFrame.encodeEffect(effect, {});
      const analysis = IRFrame.analyzePronto(result.pronto);
      assertEqual(analysis.status, 'válido', `${category.id}/${item.name}`);

      const expected = IRFrame.quantizeColor(effect.color);
      const decoded = analysis.best.info.color;
      assert(
        decoded.r === expected.r && decoded.g === expected.g && decoded.b === expected.b,
        `${category.id}/${item.name}: color alterado`,
      );

      if (effect.mode === 'configurable') {
        const info = analysis.best.info;
        for (const field of ['attack', 'sustain', 'release', 'chance', 'restrictGroupId']) {
          assertEqual(info[field], effect[field], `${category.id}/${item.name} ${field}`);
        }
      }
      count++;
    }
  }
  return `${count} presets en ${PRESETS.length} categorías`;
});

test('los presets no llevan nombres de artistas ni eventos', () => {
  // Salvaguarda del posicionamiento del proyecto: ver CONTRIBUTING.md.
  const banned = /\b(tour|concierto|concert|estadio|stadium|arena|festival|20\d\d)\b/i;
  for (const category of PRESETS) {
    for (const item of category.items) {
      assert(!banned.test(item.name), `nombre sospechoso: "${item.name}"`);
      assert(!banned.test(item.note || ''), `nota sospechosa en "${item.name}"`);
    }
  }
  return 'nomenclatura genérica';
});

// ------------------------------------------------------------ exportadores

section('Exportadores');

const sampleEntries = [
  {
    name: 'rgb(240,80,0)',
    result: IRFrame.encodeEffect({ color: { r: 240, g: 80, b: 0 } }, {}),
  },
  {
    name: 'Prueba · 2',
    result: IRFrame.encodeEffect(
      { color: { r: 0, g: 120, b: 252 }, mode: 'configurable', attack: 3 },
      {},
    ),
  },
];

test('el JSON es válido y lleva las capas', () => {
  const parsed = JSON.parse(Exporters.toJson(sampleEntries));
  assertEqual(parsed.commands.length, 2, 'comandos');
  assert(parsed.disclaimer.length > 0, 'falta el aviso');
  assert(Array.isArray(parsed.commands[0].encodedBytes), 'faltan bytes codificados');
  return `${parsed.commands.length} comandos`;
});

test('el .ir de Flipper tiene cabecera, frecuencia y datos', () => {
  const text = Exporters.toFlipper(sampleEntries);
  assert(text.startsWith('Filetype: IR signals file'), 'cabecera Flipper');
  assertEqual((text.match(/^type: raw$/gm) || []).length, 2, 'señales');
  assert(/^frequency: 38\d{3}$/m.test(text), 'frecuencia');
  const data = text.match(/^data: (.+)$/m)[1].split(' ').map(Number);
  assert(data.every(n => Number.isInteger(n) && n > 0), 'timings inválidos');
  assertEqual(data.length % 2, 0, 'timings pares');
  return `${data.length} timings`;
});

test('la cabecera C genera símbolos únicos y válidos', () => {
  const text = Exporters.toCHeader(sampleEntries);
  const symbols = [...text.matchAll(/static const uint16_t (\w+)\[\]/g)].map(m => m[1]);
  assertEqual(symbols.length, 2, 'arrays');
  assertEqual(new Set(symbols).size, symbols.length, 'símbolos únicos');
  for (const symbol of symbols) {
    assert(/^[A-Za-z_]\w*$/.test(symbol), `identificador inválido: ${symbol}`);
    assert(!symbol.includes('ir_frame_ir_frame'), `prefijo duplicado: ${symbol}`);
  }
  assert(text.includes('#endif'), 'falta el cierre del include guard');
  return symbols.join(', ');
});

test('todo archivo exportado lleva el aviso de uso', () => {
  for (const [key, format] of Object.entries(Exporters.FORMATS)) {
    const text = format.build(sampleEntries);
    assert(/no oficial/i.test(text), `${key}: falta la mención de no oficial`);
    assert(/eventos en directo/i.test(text), `${key}: falta el aviso de uso`);
  }
  return `${Object.keys(Exporters.FORMATS).length} formatos`;
});

// ---------------------------------------------------------- secuenciador

section('Secuenciador');

const shortEffect = { color: { r: 240, g: 80, b: 0 }, mode: 'short' };

function makeShow() {
  const show = Sequencer.createShow({ name: 'Prueba' });
  const [a, b] = show.channels;
  Sequencer.addClip(show, a.id, Sequencer.createClip({ at: 0, label: 'A0', effect: shortEffect }));
  Sequencer.addClip(show, a.id, Sequencer.createClip({ at: 1000, label: 'A1', effect: shortEffect }));
  Sequencer.addClip(show, b.id, Sequencer.createClip({ at: 500, label: 'B0', effect: shortEffect }));
  return show;
}

test('un show nuevo trae tres canales vacíos', () => {
  const show = Sequencer.createShow();
  assertEqual(show.channels.length, 3, 'canales');
  assertEqual(show.channels.every(c => c.clips.length === 0), true, 'vacíos');
  assertEqual(Sequencer.showDurationMs(show), 0, 'duración');
  return '3 canales';
});

test('el pulso corto dura lo que dura el destello', () => {
  const clip = Sequencer.createClip({ effect: shortEffect });
  assertEqual(Sequencer.clipDurationMs(clip), Sequencer.SHORT_PULSE_MS, 'duración');
  return `${Sequencer.SHORT_PULSE_MS} ms`;
});

test('el configurable dura attack + sustain + release', () => {
  const clip = Sequencer.createClip({
    effect: { color: { r: 1, g: 2, b: 3 }, mode: 'configurable', attack: 4, sustain: 3, release: 2 },
  });
  const expected = IRFrame.TIMER_MS[4] + IRFrame.TIMER_MS[3] + IRFrame.TIMER_MS[2];
  assertEqual(Sequencer.clipDurationMs(clip), expected, 'duración');
  return `${expected} ms`;
});

test('con gsten el sostén sale de la tabla GST', () => {
  const base = { color: { r: 1, g: 2, b: 3 }, mode: 'configurable', attack: 0, sustain: 2, release: 0 };
  const normal = Sequencer.createClip({ effect: base });
  const global = Sequencer.createClip({ effect: { ...base, useGlobalSustain: true } });
  assertEqual(Sequencer.clipDurationMs(normal), IRFrame.TIMER_MS[2], 'sin gsten');
  // El mínimo visible es cosa de la interfaz: el modelo da la duración real.
  assertEqual(Sequencer.clipDurationMs(global), IRFrame.GST_MS[2], 'con gsten');
  assert(IRFrame.TIMER_MS[2] !== IRFrame.GST_MS[2], 'las tablas coinciden, el test no prueba nada');
  return `${IRFrame.TIMER_MS[2]} vs ${IRFrame.GST_MS[2]} ms`;
});

test('la línea de tiempo sale ordenada por tiempo', () => {
  const events = Sequencer.timeline(makeShow());
  assertEqual(events.map(e => e.clip.label).join(','), 'A0,B0,A1', 'orden');
  return events.length + ' eventos';
});

test('silenciar un canal lo saca de la línea de tiempo', () => {
  const show = makeShow();
  show.channels[0].muted = true;
  assertEqual(Sequencer.timeline(show).map(e => e.clip.label).join(','), 'B0', 'solo B');
  return 'mute';
});

test('un solo activo silencia a los demás', () => {
  const show = makeShow();
  show.channels[1].solo = true;
  assertEqual(Sequencer.timeline(show).map(e => e.clip.label).join(','), 'B0', 'solo el canal en solo');
  return 'solo';
});

test('mover un clip lo reordena y nunca lo deja en negativo', () => {
  const show = makeShow();
  const first = show.channels[0].clips[0];
  Sequencer.moveClip(show, first.id, 4000);
  assertEqual(show.channels[0].clips.map(c => c.label).join(','), 'A1,A0', 'reordenado');

  const target = show.channels[0].clips[1];
  Sequencer.moveClip(show, target.id, -500);
  assertEqual(target.at, 0, 'recortado a cero');
  return 'orden y recorte';
});

test('mover un clip a otro canal lo cambia de pista', () => {
  const show = makeShow();
  const clip = show.channels[0].clips[0];
  Sequencer.moveClip(show, clip.id, 200, show.channels[2].id);
  assertEqual(show.channels[0].clips.length, 1, 'origen');
  assertEqual(show.channels[2].clips.length, 1, 'destino');
  assertEqual(show.channels[2].clips[0].id, clip.id, 'mismo clip');
  return 'canal 1 -> 3';
});

test('el transporte despacha cada clip una sola vez y en orden', () => {
  const show = makeShow();
  const sent = [];
  const transport = Sequencer.createTransport({
    show,
    transmitter: Sequencer.createEmulatedTransmitter(),
    onDispatch: e => sent.push(e.clip.label),
  });
  transport.play();
  // El primer aviso solo fija la referencia del reloj.
  transport.advance(0);
  for (let t = 100; t <= 1600; t += 100) transport.advance(t);
  assertEqual(sent.join(','), 'A0,B0,A1', 'despachados');
  return sent.length + ' eventos';
});

test('un salto grande de reloj no se salta ningún clip', () => {
  // Si la pestaña se queda en segundo plano, rAF deja de llamar: al volver
  // llega un delta enorme y todo lo vencido debe despacharse igualmente.
  const show = makeShow();
  const sent = [];
  const transport = Sequencer.createTransport({
    show,
    transmitter: Sequencer.createEmulatedTransmitter(),
    onDispatch: e => sent.push(e.clip.label),
  });
  transport.play();
  transport.advance(0);
  transport.advance(5000);
  assertEqual(sent.join(','), 'A0,B0,A1', 'nada perdido');
  return 'delta de 5 s';
});

test('buscar hacia adelante no dispara lo que quedó atrás', () => {
  const show = makeShow();
  const sent = [];
  const transport = Sequencer.createTransport({
    show,
    transmitter: Sequencer.createEmulatedTransmitter(),
    onDispatch: e => sent.push(e.clip.label),
  });
  transport.seek(900);
  transport.play();
  transport.advance(0);
  transport.advance(600);
  assertEqual(sent.join(','), 'A1', 'solo lo posterior al cursor');
  return 'seek(900)';
});

test('el transmisor emulado codifica la trama real sin transmitir', () => {
  const transmitter = Sequencer.createEmulatedTransmitter();
  assertEqual(transmitter.transmits, false, 'no transmite');
  const clip = Sequencer.createClip({ effect: shortEffect });
  const result = transmitter.send({ clip });
  assertEqual(result.ok, true, 'ok');
  const expected = IRFrame.encodeEffect(shortEffect, {});
  assertEqual(result.frame.pronto, expected.pronto, 'pronto');
  return result.frame.encoded.map(IRFrame.hexByte).join(' ');
});

test('un error del transmisor no rompe la reproducción', () => {
  const show = makeShow();
  const seen = [];
  const transport = Sequencer.createTransport({
    show,
    transmitter: { name: 'roto', send() { throw new Error('sin dispositivo'); } },
    onDispatch: e => seen.push(e.result.ok),
  });
  transport.play();
  transport.advance(0);
  transport.advance(2000);
  assertEqual(seen.length, 3, 'se intentaron los tres');
  assertEqual(seen.every(ok => ok === false), true, 'todos marcados como fallo');
  return '3 fallos capturados';
});

test('el show va y vuelve de JSON sin perder nada', () => {
  const show = makeShow();
  show.channels[1].muted = true;
  const back = Sequencer.fromJSON(JSON.parse(JSON.stringify(Sequencer.toJSON(show))));
  assertEqual(back.channels.length, show.channels.length, 'canales');
  assertEqual(
    Sequencer.timeline(back).map(e => e.clip.label + '@' + e.clip.at).join(','),
    Sequencer.timeline(show).map(e => e.clip.label + '@' + e.clip.at).join(','),
    'clips audibles',
  );
  assertEqual(Sequencer.showDurationMs(back), Sequencer.showDurationMs(show), 'duración');
  return 'ida y vuelta';
});

test('un JSON ajeno se rechaza', () => {
  let threw = false;
  try {
    Sequencer.fromJSON({ format: 'otra-cosa' });
  } catch {
    threw = true;
  }
  assert(threw, 'se aceptó un formato desconocido');
  return 'rechazado';
});

test('el show se exporta en los cuatro formatos', () => {
  const entries = Sequencer.toExportEntries(makeShow());
  assertEqual(entries.length, 3, 'entradas');
  for (const [key, format] of Object.entries(Exporters.FORMATS)) {
    const text = format.build(entries);
    assert(text.length > 0, `${key}: vacío`);
    assert(/no oficial/i.test(text), `${key}: falta el aviso`);
  }
  return `${entries.length} comandos en 4 formatos`;
});

// ------------------------------------------------- grupos del protocolo

section('Canales y grupos del protocolo');

/** El grupo tal y como queda en la trama codificada del clip. */
function groupOf(show, clipLabel) {
  const event = Sequencer.timeline(show).find(e => e.clip.label === clipLabel);
  const logical = IRFrame.decodeEncoded(
    IRFrame.encodeEffect(event.effect, event.clip.transmission).encoded,
  );
  return IRFrame.describeLogical(logical).restrictGroupId;
}

test('el primer canal es la difusión, grupo 0', () => {
  const show = Sequencer.createShow();
  assertEqual(show.channels[0].group, 0, 'grupo del primer canal');
  assertEqual(Sequencer.isBroadcastChannel(show, show.channels[0]), true, 'es difusión');
  Sequencer.addClip(
    show,
    show.channels[0].id,
    Sequencer.createClip({ label: 'B', effect: { ...shortEffect, mode: 'configurable' } }),
  );
  assertEqual(groupOf(show, 'B'), 0, 'grupo codificado');
  return 'grupo 0 en la trama';
});

test('mover un clip de canal cambia el grupo que se codifica', () => {
  const show = Sequencer.createShow();
  const clip = Sequencer.createClip({
    label: 'M',
    effect: { ...shortEffect, mode: 'configurable' },
  });
  Sequencer.addClip(show, show.channels[0].id, clip);
  assertEqual(groupOf(show, 'M'), 0, 'antes');
  Sequencer.moveClip(show, clip.id, 0, show.channels[2].id);
  assertEqual(groupOf(show, 'M'), show.channels[2].group, 'después');
  return `grupo 0 -> ${show.channels[2].group}`;
});

test('el canal de difusión no se puede eliminar ni cambiar de grupo', () => {
  const show = Sequencer.createShow();
  let cambios = 0;
  try {
    Sequencer.setChannelGroup(show, show.channels[0].id, 5);
  } catch {
    cambios++;
  }
  try {
    Sequencer.removeChannel(show, show.channels[0].id);
  } catch {
    cambios++;
  }
  assertEqual(cambios, 2, 'las dos operaciones deben rechazarse');
  assertEqual(show.channels[0].group, 0, 'sigue en el grupo 0');
  return 'difusión intacta';
});

test('un grupo fuera de 1..31 se rechaza', () => {
  const show = Sequencer.createShow();
  const id = show.channels[1].id;
  let rechazados = 0;
  for (const value of [0, -1, 32, 99, 'hola']) {
    try {
      Sequencer.setChannelGroup(show, id, value);
    } catch {
      rechazados++;
    }
  }
  assertEqual(rechazados, 5, 'valores rechazados');
  assertEqual(Sequencer.setChannelGroup(show, id, 31).group, 31, 'el 31 sí vale');
  return '5 rechazos';
});

test('dos canales no pueden compartir grupo', () => {
  const show = Sequencer.createShow();
  let threw = false;
  try {
    Sequencer.setChannelGroup(show, show.channels[1].id, show.channels[2].group);
  } catch {
    threw = true;
  }
  assert(threw, 'se aceptó un grupo repetido');
  return 'rechazado';
});

test('no caben más de 32 canales', () => {
  const show = Sequencer.createShow();
  while (show.channels.length < Sequencer.MAX_CHANNELS) Sequencer.addChannel(show);
  assertEqual(show.channels.length, 32, 'canales');
  assertEqual(new Set(show.channels.map(c => c.group)).size, 32, 'grupos distintos');
  let threw = false;
  try {
    Sequencer.addChannel(show);
  } catch {
    threw = true;
  }
  assert(threw, 'se aceptó un canal de más');
  return '32 grupos, 5 bits';
});

test('los grupos sobreviven a la ida y vuelta por JSON', () => {
  const show = Sequencer.createShow();
  Sequencer.setChannelGroup(show, show.channels[2].id, 17);
  Sequencer.addClip(show, show.channels[2].id, Sequencer.createClip({ label: 'G', effect: shortEffect }));
  const data = Sequencer.toJSON(show);
  assertEqual(data.version, 2, 'versión del formato');
  assertEqual(data.channels[2].group, 17, 'grupo guardado');
  const back = Sequencer.fromJSON(JSON.parse(JSON.stringify(data)));
  assertEqual(back.channels.map(c => c.group).join(','), '0,1,17', 'grupos recuperados');
  return '0, 1, 17';
});

test('un show de la versión 1 reparte los grupos por orden', () => {
  const old = {
    format: 'ir-frame-show',
    version: 1,
    name: 'Antiguo',
    channels: [{ name: 'Canal 1', clips: [] }, { name: 'Canal 2', clips: [] }],
  };
  const show = Sequencer.fromJSON(old);
  assertEqual(show.channels.map(c => c.group).join(','), '0,1', 'grupos asignados');
  return 'difusión primero';
});

test('las descargas dicen a qué grupo iba cada trama', () => {
  const show = Sequencer.createShow();
  Sequencer.addClip(show, show.channels[0].id, Sequencer.createClip({ label: 'B', effect: shortEffect }));
  Sequencer.addClip(show, show.channels[1].id, Sequencer.createClip({ label: 'G', effect: shortEffect }));
  const entries = Sequencer.toExportEntries(show);
  assert(/difusión \(grupo 0\)/.test(entries[0].note), `nota: ${entries[0].note}`);
  assert(/grupo 1/.test(entries[1].note), `nota: ${entries[1].note}`);
  return entries[1].note;
});

// --------------------------------------------------- envolvente simulada

section('Previsualización de la envolvente');

const envelopeClip = Sequencer.createClip({
  effect: {
    color: { r: 240, g: 80, b: 0 },
    mode: 'configurable',
    attack: 3,    // 192 ms
    sustain: 4,   // 480 ms
    release: 2,   // 96 ms
  },
});

test('la rampa de ataque sube de 0 a 1', () => {
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 0), 0, 'al empezar');
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 96), 0.5, 'a la mitad');
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 192), 1, 'al acabar el ataque');
  return '192 ms de ataque';
});

test('el sostén se mantiene plano', () => {
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 300), 1, 'dentro del sostén');
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 671), 1, 'último milisegundo');
  return '480 ms de sostén';
});

test('la rampa de relajación baja hasta 0', () => {
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 672), 1, 'al empezar a caer');
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 720), 0.5, 'a la mitad');
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 768), 0, 'al final');
  return '96 ms de relajación';
});

test('fuera del clip la intensidad es 0', () => {
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, -10), 0, 'antes');
  assertEqual(Sequencer.clipIntensityAt(envelopeClip, 5000), 0, 'después');
  assertEqual(
    Sequencer.clipIntensityAt(envelopeClip, Sequencer.clipDurationMs(envelopeClip)),
    0,
    'justo al terminar',
  );
  return 'antes y después';
});

test('con gsten el sostén lo marca la tabla global', () => {
  const global = Sequencer.createClip({
    effect: { ...envelopeClip.effect, useGlobalSustain: true },
  });
  // GST_MS[4] son 480 ms igual que TIMER_MS[4]; el índice 2 los separa.
  const corto = Sequencer.createClip({
    effect: { ...envelopeClip.effect, sustain: 2, useGlobalSustain: true },
  });
  const normal = Sequencer.createClip({
    effect: { ...envelopeClip.effect, sustain: 2 },
  });
  assertEqual(Sequencer.clipIntensityAt(global, 500), 1, 'gsten dentro del sostén');
  assertEqual(Sequencer.clipIntensityAt(corto, 192 + IRFrame.GST_MS[2] - 1), 1, 'gsten al borde');
  assert(
    Sequencer.clipIntensityAt(normal, 192 + IRFrame.GST_MS[2] - 1) < 1,
    'sin gsten, a esa altura ya debería estar cayendo',
  );
  return `${IRFrame.GST_MS[2]} ms frente a ${IRFrame.TIMER_MS[2]} ms`;
});

test('el pulso corto se ve encendido mientras dura el destello', () => {
  const clip = Sequencer.createClip({ effect: shortEffect });
  assertEqual(Sequencer.clipIntensityAt(clip, 0), 1, 'al empezar');
  assertEqual(Sequencer.clipIntensityAt(clip, Sequencer.SHORT_PULSE_MS - 1), 1, 'dentro');
  assertEqual(Sequencer.clipIntensityAt(clip, Sequencer.SHORT_PULSE_MS), 0, 'al acabar');
  return 'sin envolvente inventada';
});

// ------------------------------------------------------- cursor por audio

section('Sincronización con audio');

function watchedShow() {
  const show = makeShow();
  const sent = [];
  const transport = Sequencer.createTransport({
    show,
    transmitter: Sequencer.createEmulatedTransmitter(),
    onDispatch: e => sent.push(e.clip.label),
  });
  return { show, sent, transport };
}

test('fijar el cursor absoluto despacha lo vencido una sola vez', () => {
  const { sent, transport } = watchedShow();
  transport.play();
  // Como si la pista de audio fuese dando su posición en cada frame.
  for (const t of [0, 200, 520, 520, 700, 1100]) transport.syncTo(t);
  assertEqual(sent.join(','), 'A0,B0,A1', 'despachados');
  assertEqual(transport.state().cursor, 1100, 'cursor');
  return 'sin repeticiones';
});

test('fijar el cursor no acumula deriva del reloj', () => {
  const { transport } = watchedShow();
  transport.play();
  transport.syncTo(800);
  assertEqual(transport.state().cursor, 800, 'cursor');
  // Volver al reloj monótono debe reanclarse, no sumar el hueco de golpe.
  transport.advance(900000);
  transport.advance(900100);
  assertEqual(transport.state().cursor, 900, 'cursor tras volver a advance');
  return '800 ms exactos';
});

test('rebobinar el audio vuelve a armar los clips', () => {
  const { sent, transport } = watchedShow();
  transport.play();
  transport.syncTo(1200);
  assertEqual(sent.join(','), 'A0,B0,A1', 'primera pasada');
  transport.syncTo(0);
  transport.syncTo(1200);
  assertEqual(sent.join(','), 'A0,B0,A1,A0,B0,A1', 'segunda pasada');
  return 'bucle del audio';
});

test('reproducir con el cabezal en el final rebobina y arranca', () => {
  const { sent, transport } = watchedShow();
  const duracion = transport.state().duration;
  transport.seek(duracion);
  sent.length = 0;
  transport.play();
  assertEqual(transport.state().cursor, 0, 'cabezal rebobinado');
  assertEqual(transport.state().playing, true, 'sonando');
  transport.advance(0);
  assertEqual(sent.join(','), 'A0', 'despacha el primer clip otra vez');
  return 'del final al principio';
});

test('rebobinar deja el cabezal en cero sin tocar la reproducción', () => {
  const { transport } = watchedShow();
  transport.seek(900);
  transport.rewind();
  assertEqual(transport.state().cursor, 0, 'parado sigue parado');
  assertEqual(transport.state().playing, false, 'sin arrancar');
  transport.play();
  transport.advance(0);
  transport.advance(700);
  transport.rewind();
  assertEqual(transport.state().cursor, 0, 'cabezal a cero');
  assertEqual(transport.state().playing, true, 'sigue sonando');
  return 'rebobinado sin parar';
});

test('mover el cursor con el transporte parado no despacha nada', () => {
  const { sent, transport } = watchedShow();
  transport.syncTo(1000);
  assertEqual(sent.length, 0, 'nada despachado');
  assertEqual(transport.state().cursor, 1000, 'cursor');
  transport.play();
  transport.syncTo(1000);
  assertEqual(sent.join(','), 'A1', 'al arrancar suena lo que cae en el cursor');
  return 'búsqueda sin sonido';
});

test('los picos de la forma de onda cubren todas las columnas', () => {
  const samples = new Float32Array(1000);
  for (let i = 0; i < samples.length; i++) samples[i] = i < 500 ? 0.25 : -0.75;
  const peaks = Sequencer.audioPeaks(samples, 4);
  assertEqual(peaks.length, 4, 'columnas');
  assertEqual(peaks[0].max, 0.25, 'pico de la primera mitad');
  assertEqual(peaks[3].min, -0.75, 'valle de la segunda mitad');
  return '4 columnas';
});

test('con menos muestras que columnas los picos siguen siendo números', () => {
  const peaks = Sequencer.audioPeaks(new Float32Array([1, -1]), 8);
  assertEqual(peaks.length, 8, 'columnas');
  assertEqual(peaks.every(p => Number.isFinite(p.min) && Number.isFinite(p.max)), true, 'finitos');
  assertEqual(Sequencer.audioPeaks(new Float32Array(0), 3).length, 3, 'sin muestras');
  return '8 columnas de 2 muestras';
});

// ------------------------------------------------- transmisor por HTTP

section('Transmisor por HTTP');

/*
 * Doble de `fetch`: la suite no habla nunca con un dispositivo real, tanto por
 * no depender de la red como por no emitir infrarrojos sin que nadie lo pida.
 */
function fakeFetch(responder) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  };
  impl.calls = calls;
  return impl;
}

const okResponse = body => ({ ok: true, status: 200, json: async () => body });

testAsync('el transmisor arma la petición que espera el firmware', async () => {
  const fetchImpl = fakeFetch(() => okResponse({ ok: true }));
  const device = Sequencer.createDeviceTransmitter({
    baseUrl: 'http://led-badge.local/',
    fetchImpl,
  });
  const clip = Sequencer.createClip({ effect: shortEffect });

  const handoff = device.send({ clip });
  assertEqual(handoff.pending, true, 'no bloquea el transporte');
  const result = await handoff.settled;
  assertEqual(result.ok, true, 'aceptada');

  const { url, init } = fetchImpl.calls[0];
  assertEqual(url, 'http://led-badge.local/api/raw', 'url');
  assertEqual(init.method, 'POST', 'método');
  assertEqual(init.headers['X-Requested-With'], 'rest-client', 'cabecera de intención');
  assertEqual(init.headers['Content-Type'], 'application/x-www-form-urlencoded', 'tipo');
  assert(init.body.startsWith('pronto=0000%20'), `cuerpo inesperado: ${init.body.slice(0, 20)}`);
  assert(!init.body.includes('+'), 'los espacios deben ir como %20, no como +');
  assertEqual(
    decodeURIComponent(init.body.slice('pronto='.length)),
    IRFrame.encodeEffect(shortEffect, {}).pronto,
    'trama',
  );
  return `${init.body.length} caracteres de cuerpo`;
});

testAsync('un rechazo del dispositivo se convierte en resultado, no en excepción', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'pronto inválido' }),
  }));
  const device = Sequencer.createDeviceTransmitter({ baseUrl: 'http://led-badge.local', fetchImpl });
  const result = await device.send({ clip: Sequencer.createClip({ effect: shortEffect }) }).settled;
  assertEqual(result.ok, false, 'fallo');
  assertEqual(result.error, 'pronto inválido', 'motivo del firmware');
  return '400 explicado';
});

testAsync('un fallo de red no se propaga y llega con motivo', async () => {
  const fetchImpl = () => Promise.reject(new Error('Failed to fetch'));
  const notified = [];
  const device = Sequencer.createDeviceTransmitter({
    baseUrl: 'http://led-badge.local',
    fetchImpl,
    onResult: r => notified.push(r.ok),
  });
  const result = await device.send({ clip: Sequencer.createClip({ effect: shortEffect }) }).settled;
  assertEqual(result.ok, false, 'fallo');
  assertEqual(result.error, 'Failed to fetch', 'motivo');
  assertEqual(notified.join(','), 'false', 'se avisa del desenlace');
  return 'sin excepción';
});

testAsync('probar la conexión consulta el estado del dispositivo', async () => {
  const fetchImpl = fakeFetch(() => okResponse({ state: 'idle' }));
  const device = Sequencer.createDeviceTransmitter({ baseUrl: 'http://led-badge.local', fetchImpl });
  const result = await device.test();
  assertEqual(result.ok, true, 'responde');
  assertEqual(fetchImpl.calls[0].url, 'http://led-badge.local/api/state', 'url');
  assertEqual(fetchImpl.calls[0].init.method, 'GET', 'método');
  return 'GET /api/state';
});

test('una trama más larga de lo que acepta el dispositivo ni se envía', () => {
  const fetchImpl = fakeFetch(() => okResponse({ ok: true }));
  const device = Sequencer.createDeviceTransmitter({ baseUrl: 'http://led-badge.local', fetchImpl });
  const clip = Sequencer.createClip({
    effect: { color: { r: 10, g: 20, b: 30 }, mode: 'configurable', attack: 1, sustain: 3, release: 2 },
    transmission: { repeats: 2 },
  });
  const result = device.send({ clip });
  assertEqual(result.ok, false, 'rechazada en local');
  assertEqual(fetchImpl.calls.length, 0, 'no se llamó al dispositivo');
  assert(/caracteres/.test(result.error), `motivo poco claro: ${result.error}`);
  return result.error;
});

// ------------------------------------------------------------ distribución

section('Distribuir clips');

function showConClip(effect = shortEffect, at = 0) {
  const show = Sequencer.createShow({ name: 'Reparto' });
  const clip = Sequencer.createClip({ at, label: 'Semilla', effect });
  Sequencer.addClip(show, show.channels[0].id, clip);
  return { show, clip };
}

test('distribuir copia el clip a intervalos regulares', () => {
  const { show, clip } = showConClip();
  const result = Sequencer.distributeClip(show, clip.id, { everyMs: 500, untilMs: 2000 });
  assertEqual(result.copies.length, 4, 'copias');
  assertEqual(
    show.channels[0].clips.map(c => c.at).join(','),
    '0,500,1000,1500,2000',
    'tiempos',
  );
  return '4 copias cada 500 ms';
});

test('distribuir nunca pasa del límite', () => {
  const { show, clip } = showConClip(shortEffect, 200);
  Sequencer.distributeClip(show, clip.id, { everyMs: 300, untilMs: 1000 });
  const last = show.channels[0].clips[show.channels[0].clips.length - 1];
  assert(last.at <= 1000, `se pasó del límite: ${last.at}`);
  return `último en ${last.at} ms`;
});

test('un intervalo cero o inválido se rechaza', () => {
  const { show, clip } = showConClip();
  for (const everyMs of [0, -100, NaN, 'x']) {
    let lanzó = false;
    try {
      Sequencer.distributeClip(show, clip.id, { everyMs, untilMs: 2000 });
    } catch {
      lanzó = true;
    }
    assert(lanzó, `aceptó el intervalo ${everyMs}`);
  }
  assertEqual(show.channels[0].clips.length, 1, 'no se añadió nada');
  return '4 intervalos rechazados';
});

test('un límite anterior al clip no reparte nada', () => {
  const { show, clip } = showConClip(shortEffect, 5000);
  const result = Sequencer.distributeClip(show, clip.id, { everyMs: 250, untilMs: 1000 });
  assertEqual(result.copies.length, 0, 'copias');
  assert(/límite/.test(result.reason), `motivo poco claro: ${result.reason}`);
  return result.reason;
});

test('un intervalo minúsculo se corta en el tope y lo dice', () => {
  const { show, clip } = showConClip();
  const result = Sequencer.distributeClip(show, clip.id, { everyMs: 1, untilMs: 600000 });
  assertEqual(result.copies.length, Sequencer.MAX_DISTRIBUTE_COPIES, 'tope');
  assertEqual(result.capped, true, 'avisa');
  assert(/tope/.test(result.reason), `motivo poco claro: ${result.reason}`);
  return `tope de ${Sequencer.MAX_DISTRIBUTE_COPIES}`;
});

test('las copias heredan el efecto y llevan identidad propia', () => {
  const { show, clip } = showConClip();
  const result = Sequencer.distributeClip(show, clip.id, { everyMs: 400, untilMs: 800 });
  const copia = result.copies[0];
  assertEqual(copia.label, clip.label, 'etiqueta');
  assertEqual(copia.effect.color.r, clip.effect.color.r, 'color');
  assert(copia.id !== clip.id, 'identidad repetida');
  return copia.id;
});

// --------------------------------------------------------- formas de comando

section('Formas de comando');

test('el catálogo de formas trae valores dentro de las tablas', () => {
  for (const shape of Sequencer.CLIP_SHAPES) {
    const e = shape.effect;
    for (const key of ['attack', 'sustain', 'release']) {
      const value = e[key] || 0;
      assert(value >= 0 && value < IRFrame.TIMER_MS.length, `${shape.id}.${key} = ${value}`);
    }
    const chance = e.chance || 0;
    assert(chance >= 0 && chance < IRFrame.CHANCE_PCT.length, `${shape.id}.chance = ${chance}`);
  }
  return `${Sequencer.CLIP_SHAPES.length} formas`;
});

test('una forma con probabilidad baja se codifica como tal', () => {
  const shape = Sequencer.CLIP_SHAPES.find(item => item.id === 'chispas');
  const frame = IRFrame.encodeEffect({ color: { r: 8, g: 8, b: 8 }, ...shape.effect });
  const info = IRFrame.describeLogical(IRFrame.decodeEncoded(frame.encoded));
  assertEqual(info.chance, shape.effect.chance, 'chance');
  return `${IRFrame.CHANCE_PCT[info.chance]} %`;
});

test('el catálogo del secuenciador es solo del comando de 9 bytes', () => {
  /*
   * El comando corto delega los tiempos en la memoria del badge, así que el
   * mismo show sonaría distinto en cada aparato. El protocolo lo sigue
   * soportando y el generador lo sigue ofreciendo; el catálogo del
   * secuenciador, no.
   */
  for (const shape of Sequencer.CLIP_SHAPES) {
    assertEqual(shape.effect.mode, 'configurable', `${shape.id} no es configurable`);
    assertEqual(shape.effect.useGlobalSustain, undefined, `${shape.id} usa el sostén global`);
  }
  assertEqual(
    Sequencer.CLIP_SHAPES.some(shape => shape.id === 'pulso-corto'),
    false,
    'sigue estando el pulso del badge',
  );
  return `${Sequencer.CLIP_SHAPES.length} formas configurables`;
});

test('un comando corto no coincide con ninguna forma del catálogo', () => {
  const corta = Sequencer.matchShape({ mode: 'short', color: { r: 1, g: 2, b: 3 } });
  assertEqual(corta, null, 'corta');
  const larga = Sequencer.matchShape({
    mode: 'configurable',
    attack: 0,
    sustain: 5,
    release: 1,
    chance: 0,
  });
  assertEqual(larga && larga.id, 'pulso-largo', 'configurable');
  return larga.id;
});

test('la emisión apaga los campos que dependen de la memoria del badge', () => {
  const show = Sequencer.createShow({ name: 'Estado' });
  const clip = Sequencer.createClip({
    effect: {
      color: { r: 10, g: 20, b: 30 },
      mode: 'configurable',
      attack: 2,
      sustain: 3,
      release: 2,
      useGlobalSustain: true,
      onStart: true,
      repeatEnabled: true,
    },
  });
  Sequencer.addClip(show, show.channels[0].id, clip);

  const effect = Sequencer.effectFor(show.channels[0], clip);
  assertEqual(effect.useGlobalSustain, false, 'gsten');
  assertEqual(effect.onStart, false, 'onStart');
  assertEqual(effect.repeatEnabled, false, 'repeatEnabled');

  const info = IRFrame.describeLogical(
    IRFrame.decodeEncoded(IRFrame.encodeEffect(effect).encoded),
  );
  assertEqual(info.useGlobalSustain, false, 'gsten en la trama');
  assertEqual(info.repeatEnabled, false, 'repetición en la trama');
  return 'sin estado del aparato en la trama';
});

test('una sesión antigua con un clip corto se sigue cargando', () => {
  const data = {
    format: Sequencer.SHOW_FORMAT,
    version: Sequencer.SHOW_VERSION,
    name: 'Antigua',
    channels: [
      {
        name: 'Difusión',
        group: 0,
        clips: [{ at: 250, label: 'Viejo', effect: { color: { r: 1, g: 2, b: 3 }, mode: 'short' } }],
      },
    ],
  };
  const show = Sequencer.fromJSON(data);
  const clip = show.channels[0].clips[0];
  assertEqual(clip.effect.mode, 'short', 'se conserva tal cual');
  assertEqual(Sequencer.clipDurationMs(clip), Sequencer.SHORT_PULSE_MS, 'duración');
  assertEqual(Sequencer.timeline(show).length, 1, 'se puede reproducir');
  return 'compatible hacia atrás';
});

test('matchShape reconoce una forma del catálogo y no una a medida', () => {
  const shape = Sequencer.CLIP_SHAPES.find(item => item.id === 'fundido-largo');
  const igual = Sequencer.matchShape({ color: { r: 0, g: 0, b: 0 }, ...shape.effect });
  assertEqual(igual && igual.id, 'fundido-largo', 'reconocida');
  const otra = Sequencer.matchShape({
    mode: 'configurable',
    attack: 7,
    sustain: 7,
    release: 7,
    chance: 1,
  });
  assertEqual(otra, null, 'a medida');
  return 'fundido-largo';
});

// -------------------------------------------------------- guardar y cargar

section('Guardar y cargar el show');

test('la ida y vuelta conserva grupos, silencios, solos y tiempos', () => {
  const show = makeShow();
  Sequencer.setChannelGroup(show, show.channels[1].id, 9);
  show.channels[1].muted = true;
  show.channels[2].solo = true;

  const vuelta = Sequencer.fromJSON(JSON.parse(JSON.stringify(Sequencer.toJSON(show))));
  assertEqual(
    vuelta.channels.map(c => c.group).join(','),
    show.channels.map(c => c.group).join(','),
    'grupos',
  );
  assertEqual(vuelta.channels[1].muted, true, 'silenciado');
  assertEqual(vuelta.channels[2].solo, true, 'solo');
  assertEqual(
    vuelta.channels[0].clips.map(c => c.at).join(','),
    show.channels[0].clips.map(c => c.at).join(','),
    'tiempos',
  );
  return `grupos ${vuelta.channels.map(c => c.group).join('/')}`;
});

test('un show de la versión 1 se abre con grupos repartidos por orden', () => {
  const data = Sequencer.toJSON(makeShow());
  data.version = 1;
  for (const channel of data.channels) delete channel.group;

  const vuelta = Sequencer.fromJSON(data);
  assertEqual(vuelta.channels.map(c => c.group).join(','), '0,1,2', 'grupos por orden');
  return 'difusión y correlativos';
});

test('un archivo de otro formato o corrupto se rechaza con motivo', () => {
  const casos = [
    [null, 'nulo'],
    [{ format: 'otra-cosa' }, 'otro formato'],
    [{ format: 'ir-frame-show', version: 99, channels: [] }, 'versión futura'],
    [{ format: 'ir-frame-show', version: 2 }, 'sin canales'],
    [{ format: 'ir-frame-show', version: 2, channels: [{ group: 77, clips: [] }] }, 'grupo'],
    [
      { format: 'ir-frame-show', version: 2, channels: [{ group: 0, clips: [{ at: 'x' }] }] },
      'clip sin tiempo',
    ],
  ];
  for (const [data, etiqueta] of casos) {
    let mensaje = null;
    try {
      Sequencer.fromJSON(data);
    } catch (error) {
      mensaje = error.message;
    }
    assert(mensaje, `aceptó un caso inválido: ${etiqueta}`);
    assert(mensaje.length > 5, `mensaje poco claro en ${etiqueta}: ${mensaje}`);
  }
  return `${casos.length} casos rechazados`;
});

test('un archivo inválido no deja el show a medias', () => {
  const show = makeShow();
  const antes = JSON.stringify(Sequencer.toJSON(show));
  const roto = Sequencer.toJSON(show);
  roto.channels[1].clips[0].effect = null;

  let lanzó = false;
  try {
    Sequencer.fromJSON(roto);
  } catch {
    lanzó = true;
  }
  assert(lanzó, 'aceptó un clip sin efecto');
  assertEqual(JSON.stringify(Sequencer.toJSON(show)), antes, 'el show abierto cambió');
  return 'show intacto';
});

// ------------------------------------------------------------------ sesiones

section('Sesiones guardadas');

/** Doble de localStorage: un objeto con los mismos dos métodos y nada más. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
  };
}

function storeConReloj(storage, start = 1000) {
  let clock = start;
  const store = Sequencer.createSessionStore({ storage, now: () => (clock += 1000) });
  return store;
}

test('una sesión guardada vuelve con sus clips, grupos y vista', () => {
  const storage = fakeStorage();
  const store = storeConReloj(storage);
  const show = makeShow();
  Sequencer.setChannelGroup(show, show.channels[1].id, 12);
  show.channels[2].muted = true;

  const guardado = store.save({
    name: 'Ensayo',
    show,
    view: { pxPerSecond: 140, snapMs: 250 },
    audioName: 'cancion.wav',
  });
  assertEqual(guardado.ok, true, 'se guardó');

  const vuelta = store.load(guardado.id);
  assertEqual(vuelta.ok, true, 'se cargó');
  assertEqual(vuelta.session.view.pxPerSecond, 140, 'zoom');
  assertEqual(vuelta.session.view.snapMs, 250, 'ajuste');
  assertEqual(vuelta.session.audioName, 'cancion.wav', 'nombre del audio');
  assertEqual(vuelta.session.show.channels[1].group, 12, 'grupo');
  assertEqual(vuelta.session.show.channels[2].muted, true, 'silencio');
  assertEqual(
    vuelta.session.show.channels[0].clips.map(c => c.at).join(','),
    '0,1000',
    'tiempos',
  );
  return 'ida y vuelta completa';
});

test('la sesión más reciente es la que se ofrece al abrir', () => {
  const store = storeConReloj(fakeStorage());
  store.save({ name: 'Vieja', show: makeShow() });
  const media = store.save({ name: 'Media', show: makeShow() });
  const nueva = store.save({ name: 'Nueva', show: makeShow() });

  assertEqual(store.latest().id, nueva.id, 'la última');
  assertEqual(store.list().map(s => s.name).join(','), 'Nueva,Media,Vieja', 'orden');
  assert(store.list()[1].id === media.id, 'la de en medio');
  assertEqual(store.list()[0].clips, 3, 'cuenta de clips');
  return 'ordenadas por fecha';
});

test('guardar otra sesión no pisa la anterior, y renombrar y borrar funcionan', () => {
  const store = storeConReloj(fakeStorage());
  const una = store.save({ name: 'Una', show: makeShow() });
  const otra = store.save({ name: 'Otra', show: makeShow() });
  assertEqual(store.list().length, 2, 'dos sesiones');

  store.rename(una.id, 'Renombrada');
  assertEqual(store.load(una.id).session.name, 'Renombrada', 'renombrada');

  store.remove(otra.id);
  assertEqual(store.list().length, 1, 'queda una');
  assertEqual(store.load(otra.id).ok, false, 'la borrada ya no está');
  return 'dos sesiones independientes';
});

test('un almacenamiento que lanza al leer no rompe nada', () => {
  const storage = {
    getItem: () => {
      throw new Error('almacenamiento bloqueado');
    },
    setItem: () => {},
  };
  const store = Sequencer.createSessionStore({ storage });
  assertEqual(store.list().length, 0, 'lista vacía');
  assertEqual(store.latest(), null, 'sin última');
  assertEqual(store.load('lo-que-sea').ok, false, 'carga fallida sin excepción');
  return 'lectura protegida';
});

test('la cuota llena se avisa en vez de perder el trabajo en silencio', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      const error = new Error('cuota');
      error.name = 'QuotaExceededError';
      throw error;
    },
  };
  const store = Sequencer.createSessionStore({ storage });
  const result = store.save({ name: 'Grande', show: makeShow() });
  assertEqual(result.ok, false, 'no se guardó');
  assert(/almacenamiento/.test(result.error), `motivo poco claro: ${result.error}`);
  return result.error;
});

test('contenido corrupto se descarta y se arranca con lo de siempre', () => {
  const basura = fakeStorage({ [Sequencer.SESSION_KEY]: 'esto no es json' });
  assertEqual(Sequencer.createSessionStore({ storage: basura }).list().length, 0, 'basura');

  const otraVersion = fakeStorage({
    [Sequencer.SESSION_KEY]: JSON.stringify({ version: 99, sessions: [{ id: 'x', show: {} }] }),
  });
  assertEqual(
    Sequencer.createSessionStore({ storage: otraVersion }).list().length,
    0,
    'versión desconocida',
  );

  const showRoto = fakeStorage({
    [Sequencer.SESSION_KEY]: JSON.stringify({
      version: Sequencer.SESSION_STORE_VERSION,
      sessions: [{ id: 'rota', name: 'Rota', updatedAt: 5, show: { format: 'otra-cosa' } }],
    }),
  });
  const store = Sequencer.createSessionStore({ storage: showRoto });
  assertEqual(store.list().length, 1, 'aparece en la lista');
  const cargada = store.load('rota');
  assertEqual(cargada.ok, false, 'no se carga');
  assertEqual(cargada.discarded, true, 'se descarta');
  assertEqual(store.list().length, 0, 'y desaparece');
  return 'descartada con motivo';
});

// ------------------------------------------------------------------ final

function report() {
  const total = passed + failures.length;
  process.stdout.write(`\n${passed}/${total} comprobaciones pasan\n`);

  if (failures.length) {
    process.stdout.write(`\n${failures.length} fallo(s):\n`);
    for (const failure of failures) {
      process.stdout.write(`  · ${failure.name}: ${failure.message}\n`);
    }
    process.exit(1);
  }
}

runAsyncTests().then(report);
