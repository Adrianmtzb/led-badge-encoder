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

// ------------------------------------------------------------------ final

const total = passed + failures.length;
process.stdout.write(`\n${passed}/${total} comprobaciones pasan\n`);

if (failures.length) {
  process.stdout.write(`\n${failures.length} fallo(s):\n`);
  for (const failure of failures) {
    process.stdout.write(`  · ${failure.name}: ${failure.message}\n`);
  }
  process.exit(1);
}
