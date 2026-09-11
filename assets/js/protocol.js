/*
 * Capa de protocolo IR.
 *
 * Implementación escrita a partir de documentación pública del protocolo,
 * publicada por la comunidad bajo licencia MIT. Ver README y
 * THIRD_PARTY_NOTICES.md para las fuentes y su autoría. Uso educativo.
 *
 * Capas:
 *   substitution / checksum  -> tabla de 64 entradas y checksum
 *   commands                 -> parámetros de efecto a bytes lógicos
 *   bitstream                -> LSB-first, recorte, run-length
 *   pronto                   -> serializar y parsear Pronto Hex
 *   decode                   -> Pronto recibido a comando interpretado
 */

const IRFrame = (() => {
  'use strict';

  // ---------------------------------------------------------------- tabla

  /** Tabla de sustitución de 64 entradas (documentación del protocolo). */
  const TABLE = Object.freeze([
    0x21, 0x32, 0x54, 0x65, 0xa9, 0x9a, 0x6d, 0x29,
    0x56, 0x92, 0xa1, 0xb4, 0xb2, 0x84, 0x66, 0x2a,
    0x4c, 0x6a, 0xa6, 0x95, 0x62, 0x51, 0x42, 0x24,
    0x35, 0x46, 0x8a, 0xac, 0x8c, 0x6c, 0x2c, 0x4a,
    0x59, 0x86, 0xa4, 0xa2, 0x91, 0x64, 0x55, 0x44,
    0x22, 0x31, 0xb1, 0x52, 0x85, 0x96, 0xa5, 0x69,
    0x5a, 0x2d, 0x4d, 0x89, 0x45, 0x34, 0x61, 0x25,
    0x36, 0xad, 0x94, 0xaa, 0x8d, 0x49, 0x99, 0x26,
  ]);

  /** encodedByte -> valor lógico de 6 bits. */
  const INVERSE = (() => {
    const map = new Map();
    TABLE.forEach((encoded, logical) => map.set(encoded, logical));
    return map;
  })();

  const MAGIC = 0x80;

  /** Tiempos de attack / sustain / release, en ms (documentación del protocolo). */
  const TIMER_MS = Object.freeze([0, 32, 96, 192, 480, 960, 2400, 3840]);

  /** Probabilidad de ejecución por clave de 3 bits (documentación del protocolo). */
  const CHANCE_PCT = Object.freeze([100, 88, 67, 50, 32, 16, 10, 4]);

  /** Global Sustain Time por clave de 3 bits (documentación del protocolo). */
  const GST_MS = Object.freeze([64, 112, 160, 208, 480, 960, 2400, 3840]);

  // ------------------------------------------------------------- física

  /** Celda temporal nominal del protocolo, en microsegundos (documentación del protocolo). */
  const CELL_US_NOMINAL = 694.44;

  /** Unidad de tiempo Pronto, en microsegundos por unidad de portadora. */
  const PRONTO_TICK_US = 0.241246;

  /** Divisor de frecuencia de las capturas: 0x6D ~= 38.03 kHz. */
  const FREQ_WORD_38K = 0x6d;

  /**
   * Unidades Pronto por celda en el preset "compatible con capturas".
   * No es 27 fijo: las tramas documentadas usan 27/53/80/106 para 1T/2T/3T/4T,
   * que es exactamente round(celdas * 26.5). Cuantizar el run completo con
   * este factor las reproduce byte a byte.
   */
  const CAPTURE_CELL_UNITS = 26.5; // ~697 us por celda

  /** Separador observado entre comandos repetidos (documentación del protocolo). */
  const SEPARATOR_BITS = Object.freeze([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const clamp8 = value => clamp(Math.round(value) || 0, 0, 255);
  const hexWord = value => value.toString(16).toUpperCase().padStart(4, '0');
  const hexByte = value => value.toString(16).toUpperCase().padStart(2, '0');

  /** Microsegundos que dura una unidad Pronto para un divisor dado. */
  const prontoUnitUs = freqWord => freqWord * PRONTO_TICK_US;

  /** Portadora aproximada en Hz para un divisor Pronto. */
  const carrierHz = freqWord => 1 / (freqWord * PRONTO_TICK_US * 1e-6);

  // ------------------------------------------------------------ checksum

  /**
   * Checksum sobre los bytes YA sustituidos (documentación del protocolo): suma de 8 bits,
   * seis bits altos, y ese valor vuelve a pasar por la tabla.
   */
  function checksum(encodedPayload) {
    const sum8 = encodedPayload.reduce((sum, value) => (sum + value) & 0xff, 0);
    return TABLE[(sum8 >> 2) & 0x3f];
  }

  /**
   * Bytes lógicos -> bytes transmitidos. El magic no se sustituye y el
   * checksum se calcula sobre el payload ya codificado.
   */
  function encodeLogical(logical) {
    if (logical.length < 3) throw new Error('Comando lógico demasiado corto');
    const payload = logical.slice(2).map(value => {
      if (value < 0 || value > 0x3f) {
        throw new Error(`Valor lógico fuera de rango 0..63: ${value}`);
      }
      return TABLE[value];
    });
    return [MAGIC, checksum(payload), ...payload];
  }

  /** Bytes transmitidos -> bytes lógicos. Lanza si algo no cuadra. */
  function decodeEncoded(encoded) {
    if (encoded.length < 3) throw new Error('Frame demasiado corto');
    if (encoded[0] !== MAGIC) throw new Error(`Magic inválido: 0x${hexByte(encoded[0])}`);
    const payload = encoded.slice(2);
    const logicalPayload = payload.map(byte => {
      const logical = INVERSE.get(byte);
      if (logical === undefined) {
        throw new Error(`Byte 0x${hexByte(byte)} no existe en la tabla de sustitución`);
      }
      return logical;
    });
    const expected = checksum(payload);
    if (expected !== encoded[1]) {
      throw new Error(
        `Checksum recibido 0x${hexByte(encoded[1])}, calculado 0x${hexByte(expected)}`,
      );
    }
    return [MAGIC, 0x00, ...logicalPayload];
  }

  // ------------------------------------------------------------ comandos

  /** Cuantización real que aplica el badge: 6 bits por canal. */
  function quantizeColor({ r, g, b }) {
    return {
      r: clamp8(r) & 0xfc,
      g: clamp8(g) & 0xfc,
      b: clamp8(b) & 0xfc,
    };
  }

  /**
   * Bytes lógicos de un efecto de color único.
   *
   * mode 'short'        -> 6 bytes, temporización fija del badge
   * mode 'configurable' -> 9 bytes, attack/sustain/release/chance/grupo
   */
  function buildSingleColor(effect) {
    const {
      color,
      mode = 'short',
      attack = 0,
      sustain = 3,
      release = 1,
      chance = 0,
      restrictGroupId = 0,
      repeatEnabled = false,
      onStart = false,
      useGlobalSustain = false,
    } = effect;

    const type = 0b000;
    const flags =
      ((useGlobalSustain ? 1 : 0) << 4) | ((type & 0b111) << 1) | (onStart ? 1 : 0);

    const { r, g, b } = quantizeColor(color);
    const logical = [MAGIC, 0x00, flags, g >> 2, r >> 2, b >> 2];

    if (mode === 'short') return logical;

    const group = clamp(Math.round(restrictGroupId) || 0, 0, 31);
    logical.push(((attack & 0b111) << 3) | (chance & 0b111));
    logical.push(((release & 0b111) << 3) | (sustain & 0b111));
    logical.push(((repeatEnabled ? 1 : 0) << 5) | group);
    return logical;
  }

  /** Interpreta bytes lógicos ya decodificados a campos legibles. */
  function describeLogical(logical) {
    const flags = logical[2];
    const type = (flags >> 1) & 0b111;
    const info = {
      length: logical.length,
      mode: logical.length >= 9 ? 'configurable' : 'short',
      type,
      typeBits: type.toString(2).padStart(3, '0'),
      onStart: Boolean(flags & 0b1),
      useGlobalSustain: Boolean((flags >> 4) & 0b1),
      reserved: (flags >> 5) & 0b1,
    };

    if (type === 0b000 && logical.length >= 6) {
      const g = logical[3] << 2;
      const r = logical[4] << 2;
      const b = logical[5] << 2;
      info.color = { r, g, b };
    }

    if (logical.length >= 9) {
      info.attack = (logical[6] >> 3) & 0b111;
      info.chance = logical[6] & 0b111;
      info.release = (logical[7] >> 3) & 0b111;
      info.sustain = logical[7] & 0b111;
      info.repeatEnabled = Boolean((logical[8] >> 5) & 0b1);
      info.restrictGroupId = logical[8] & 0b11111;
    }

    return info;
  }

  // ----------------------------------------------------------- bitstream

  /** Bytes -> bits, el menos significativo primero (documentación del protocolo). */
  function bytesToBits(bytes) {
    const bits = [];
    for (const byte of bytes) {
      for (let bit = 0; bit < 8; bit++) bits.push((byte >> bit) & 1);
    }
    return bits;
  }

  /** Agrupa bits LSB-first en bytes. Descarta un resto incompleto. */
  function bitsToBytes(bits) {
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) byte |= bits[i + bit] << bit;
      bytes.push(byte);
    }
    return bytes;
  }

  /**
   * El receptor no distingue ceros de silencio en los extremos, así que se
   * recortan. La señal resultante empieza y termina siempre en 1.
   */
  function trimZeros(bits) {
    let start = 0;
    let end = bits.length;
    while (start < end && bits[start] === 0) start++;
    while (end > start && bits[end - 1] === 0) end--;
    return bits.slice(start, end);
  }

  function runLengthEncode(bits) {
    if (!bits.length) return [];
    const runs = [];
    let bit = bits[0];
    let cells = 1;
    for (let i = 1; i < bits.length; i++) {
      if (bits[i] === bit) {
        cells++;
      } else {
        runs.push({ bit, cells });
        bit = bits[i];
        cells = 1;
      }
    }
    runs.push({ bit, cells });
    return runs;
  }

  function runsToBits(runs) {
    const bits = [];
    for (const run of runs) {
      for (let i = 0; i < run.cells; i++) bits.push(run.bit);
    }
    return bits;
  }

  /**
   * Construye el bitstream completo de una transmisión: N repeticiones del
   * paquete, con separador opcional y silencio entre repeticiones.
   */
  function buildTransmissionBits(encodedBytes, options = {}) {
    const { repeats = 1, includeSeparator = false, gapCells = 0 } = options;
    const packet = trimZeros(bytesToBits(encodedBytes));
    const bits = [];
    for (let i = 0; i < Math.max(1, repeats); i++) {
      if (i > 0) {
        for (let c = 0; c < gapCells; c++) bits.push(0);
      }
      if (includeSeparator) bits.push(...SEPARATOR_BITS);
      bits.push(...packet);
    }
    return bits;
  }

  // -------------------------------------------------------------- pronto

  /**
   * Runs de celdas -> duraciones Pronto alternando MARK/SPACE.
   *
   * timing 'capture' fija 27 unidades por celda, que es lo que aparece en las
   * capturas conocidas. 'nominal' cuantiza cada run completo contra la celda
   * teórica de 694.44 us para no acumular error de redondeo.
   */
  function runsToDurations(runs, options = {}) {
    const {
      timing = 'capture',
      freqWord = FREQ_WORD_38K,
      cellUs = CELL_US_NOMINAL,
      gapUs = 49960,
    } = options;

    const unitUs = prontoUnitUs(freqWord);
    const cellUnits = run =>
      timing === 'capture'
        ? Math.max(1, Math.round(run.cells * CAPTURE_CELL_UNITS))
        : Math.max(1, Math.round((run.cells * cellUs) / unitUs));

    const durations = [];
    let expected = 1; // Pronto raw debe empezar en MARK.
    for (const run of runs) {
      if (run.bit !== expected) {
        // Un bitstream recortado nunca debería llegar aquí; si pasa, se
        // inserta una duración mínima para mantener la alternancia.
        durations.push(1);
        expected ^= 1;
      }
      durations.push(cellUnits(run));
      expected ^= 1;
    }

    // Toda transmisión termina en silencio: si el último run fue MARK se
    // añade el gap de separación entre paquetes.
    if (durations.length % 2 === 1) {
      durations.push(Math.max(1, Math.round(gapUs / unitUs)));
    }
    return durations;
  }

  /** Duraciones -> cadena Pronto Hex completa con cabecera. */
  function serializePronto(durations, freqWord = FREQ_WORD_38K) {
    if (durations.length % 2 !== 0) {
      throw new Error('Pronto requiere un número par de duraciones');
    }
    const words = [0x0000, freqWord, durations.length / 2, 0x0000, ...durations];
    return words.map(hexWord).join(' ');
  }

  /** Parsea Pronto Hex y valida la cabecera (documentación del protocolo). */
  function parsePronto(text) {
    const tokens = String(text).trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.length < 4) throw new Error('Faltan words de cabecera');
    for (const token of tokens) {
      if (!/^[0-9a-fA-F]{4}$/.test(token)) {
        throw new Error(`"${token}" no es un word hexadecimal de 4 dígitos`);
      }
    }

    const words = tokens.map(token => parseInt(token, 16));
    const [format, freqWord, introPairs, repeatPairs] = words;
    if (format !== 0x0000) {
      throw new Error(`Formato 0x${hexWord(format)} no soportado (se espera 0000)`);
    }
    if (!freqWord) throw new Error('El divisor de frecuencia no puede ser cero');

    const durations = words.slice(4);
    const declared = (introPairs + repeatPairs) * 2;
    if (declared !== durations.length) {
      throw new Error(
        `La cabecera declara ${declared} duraciones y hay ${durations.length}`,
      );
    }
    if (durations.length % 2 !== 0) {
      throw new Error('Número impar de duraciones MARK/SPACE');
    }

    return {
      freqWord,
      introPairs,
      repeatPairs,
      durations,
      unitUs: prontoUnitUs(freqWord),
      carrierHz: carrierHz(freqWord),
    };
  }

  // -------------------------------------------------------------- decode

  /**
   * Estima la celda T a partir de las duraciones: la más corta suele ser 1T,
   * ignorando el gap final, que es un orden de magnitud mayor.
   */
  function estimateCellUnits(durations) {
    const body = durations.filter(d => d > 0);
    if (!body.length) return CAPTURE_CELL_UNITS;
    const sorted = [...body].sort((a, b) => a - b);
    const shortest = sorted[0];
    // Promedia las duraciones que caen dentro de 1.5x de la más corta.
    const ones = sorted.filter(d => d <= shortest * 1.5);
    return ones.reduce((sum, d) => sum + d, 0) / ones.length;
  }

  /**
   * Pronto -> bitstream, separando el gap final. Cada duración se redondea a
   * un número entero de celdas.
   */
  function prontoToBits(parsed, cellUnitsOverride) {
    const { durations } = parsed;
    const cellUnits = cellUnitsOverride || estimateCellUnits(durations);

    // El gap final separa transmisiones; no es payload.
    const gapThreshold = cellUnits * 8;
    let end = durations.length;
    let gapUnits = 0;
    if (end > 0 && durations[end - 1] >= gapThreshold) {
      gapUnits = durations[end - 1];
      end -= 1;
    }

    const runs = [];
    let residual = 0;
    for (let i = 0; i < end; i++) {
      const exact = durations[i] / cellUnits;
      const cells = Math.max(1, Math.round(exact));
      residual += Math.abs(exact - cells);
      runs.push({ bit: i % 2 === 0 ? 1 : 0, cells });
    }

    return {
      runs,
      bits: runsToBits(runs),
      cellUnits,
      gapUnits,
      gapUs: gapUnits * parsed.unitUs,
      residual: runs.length ? residual / runs.length : 0,
    };
  }

  /**
   * Prueba alineaciones de padding y devuelve candidatos puntuados.
   * Los ceros de los extremos pueden haberse perdido en la captura, así que se
   * reinsertan de 0 a 7 por lado hasta encontrar un frame válido (documentación del protocolo).
   */
  function decodeBits(bits) {
    const candidates = [];
    const seen = new Set();

    for (let lead = 0; lead <= 7; lead++) {
      for (let tail = 0; tail <= 7; tail++) {
        const padded = [
          ...new Array(lead).fill(0),
          ...bits,
          ...new Array(tail).fill(0),
        ];
        if (padded.length % 8 !== 0) continue;

        const bytes = bitsToBytes(padded);
        if (bytes.length !== 6 && bytes.length !== 9) continue;

        const key = bytes.join(',');
        if (seen.has(key)) continue;
        seen.add(key);

        const candidate = { lead, tail, bytes, status: 'desconocido' };
        try {
          const logical = decodeEncoded(bytes);
          candidate.logical = logical;
          candidate.info = describeLogical(logical);
          candidate.status = 'válido';
        } catch (error) {
          candidate.error = error.message;
        }
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'válido' ? -1 : 1;
      return a.lead + a.tail - (b.lead + b.tail);
    });
    return candidates;
  }

  /** Pipeline completo de análisis: texto Pronto -> diagnóstico. */
  function analyzePronto(text) {
    const parsed = parsePronto(text);
    const signal = prontoToBits(parsed);
    const candidates = decodeBits(signal.bits);
    const best = candidates.find(c => c.status === 'válido') || candidates[0] || null;

    let status = 'desconocido';
    if (best && best.status === 'válido') {
      status = signal.residual < 0.2 ? 'válido' : 'plausible';
    }

    return { parsed, signal, candidates, best, status };
  }

  // ------------------------------------------------------------ pipeline

  /**
   * Efecto + opciones de transmisión -> todas las representaciones que la
   * interfaz necesita mostrar o exportar.
   */
  function encodeEffect(effect, options = {}) {
    const {
      timing = 'capture',
      freqWord = FREQ_WORD_38K,
      cellUs = CELL_US_NOMINAL,
      gapUs = 49960,
      repeats = 1,
      includeSeparator = false,
    } = options;

    const logical = buildSingleColor(effect);
    const encoded = encodeLogical(logical);

    const unitUs = prontoUnitUs(freqWord);
    const gapCells = Math.max(1, Math.round(gapUs / cellUs));
    const bits = buildTransmissionBits(encoded, { repeats, includeSeparator, gapCells });
    const runs = runLengthEncode(bits);
    const durations = runsToDurations(runs, { timing, freqWord, cellUs, gapUs });
    const pronto = serializePronto(durations, freqWord);

    const totalUs = durations.reduce((sum, d) => sum + d, 0) * unitUs;

    return {
      effect,
      logical,
      encoded,
      bits,
      runs,
      durations,
      pronto,
      microseconds: durations.map(d => Math.round(d * unitUs)),
      carrierHz: carrierHz(freqWord),
      unitUs,
      totalUs,
      quantized: quantizeColor(effect.color),
    };
  }

  return {
    TABLE,
    INVERSE,
    MAGIC,
    TIMER_MS,
    CHANCE_PCT,
    GST_MS,
    CELL_US_NOMINAL,
    PRONTO_TICK_US,
    FREQ_WORD_38K,
    CAPTURE_CELL_UNITS,
    SEPARATOR_BITS,
    clamp,
    clamp8,
    hexWord,
    hexByte,
    prontoUnitUs,
    carrierHz,
    checksum,
    encodeLogical,
    decodeEncoded,
    quantizeColor,
    buildSingleColor,
    describeLogical,
    bytesToBits,
    bitsToBytes,
    trimZeros,
    runLengthEncode,
    runsToBits,
    buildTransmissionBits,
    runsToDurations,
    serializePronto,
    parsePronto,
    estimateCellUnits,
    prontoToBits,
    decodeBits,
    analyzePronto,
    encodeEffect,
  };
})();
