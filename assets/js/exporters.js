/*
 * Exportadores. Cada uno recibe entradas ya codificadas por IRFrame.encodeEffect
 * y devuelve { filename, mime, text } listo para descargar.
 */

const Exporters = (() => {
  'use strict';

  const slug = text =>
    String(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'ir-frame';

  const hex = bytes => bytes.map(IRFrame.hexByte).join(' ');

  // Este encabezado viaja dentro de cada archivo descargado: es lo que sigue
  // explicando el contexto cuando el archivo circula fuera de la web.
  const HEADER = [
    'Generado con IR Frame Generator, herramienta independiente y no oficial.',
    'Compatible con badges PixMob. No afiliado ni respaldado por PixMob / Eski Inc.',
    'Estas tramas se calculan a partir de documentación pública del protocolo,',
    'publicada bajo MIT por James Wang y Dani Weidman. Este proyecto no captura',
    'señales ni analiza dispositivos: solo implementa lo que ya estaba documentado.',
    'Uso solo con dispositivos propios o autorizados. No usar en eventos en directo',
    'ni para interferir con espectáculos o equipos de terceros.',
    'Verifica siempre con tu propio hardware antes de confiar en la salida.',
  ];

  /** Texto plano legible: Pronto más todas las capas intermedias. */
  function toText(entries) {
    const lines = HEADER.map(line => `# ${line}`);
    lines.push('');
    for (const { name, result } of entries) {
      const { r, g, b } = result.quantized;
      lines.push(`## ${name}`);
      lines.push(`rgb(${r}, ${g}, ${b})   modo: ${result.effect.mode}`);
      lines.push(`bytes lógicos:    ${hex(result.logical)}`);
      lines.push(`bytes codificados: ${hex(result.encoded)}`);
      lines.push(`bits (${result.bits.length}): ${result.bits.join('')}`);
      lines.push(`pronto: ${result.pronto}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /** JSON estructurado, pensado para consumir desde otro programa. */
  function toJson(entries) {
    return JSON.stringify(
      {
        generator: 'IR Frame Generator (unofficial, PixMob-compatible)',
        disclaimer: HEADER.join(' '),
        generatedAt: new Date().toISOString(),
        commands: entries.map(({ name, note, result }) => ({
          name,
          note: note || undefined,
          mode: result.effect.mode,
          requestedColor: result.effect.color,
          quantizedColor: result.quantized,
          logicalBytes: result.logical,
          encodedBytes: result.encoded,
          bits: result.bits.join(''),
          carrierHz: Math.round(result.carrierHz),
          prontoHex: result.pronto,
          rawTimingsUs: result.microseconds,
        })),
      },
      null,
      2,
    );
  }

  /** Formato .ir de Flipper Zero, señales raw. */
  function toFlipper(entries) {
    const lines = ['Filetype: IR signals file', 'Version: 1'];
    for (const line of HEADER) lines.push(`# ${line}`);
    for (const { name, result } of entries) {
      lines.push('#');
      lines.push(`name: ${name.slice(0, 31)}`);
      lines.push('type: raw');
      lines.push(`frequency: ${Math.round(result.carrierHz)}`);
      lines.push('duty_cycle: 0.330000');
      lines.push(`data: ${result.microseconds.join(' ')}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  /** Cabecera C con arrays de timings, para Arduino / ESP32. */
  function toCHeader(entries) {
    const lines = HEADER.map(line => `/* ${line} */`);
    lines.push('');
    lines.push('#ifndef IR_FRAME_CODES_H');
    lines.push('#define IR_FRAME_CODES_H');
    lines.push('');
    lines.push('#include <stdint.h>');
    lines.push('');
    lines.push(`#define IR_FRAME_CARRIER_HZ ${Math.round(entries[0].result.carrierHz)}`);
    lines.push('');

    const names = [];
    entries.forEach(({ name, result }, index) => {
      // El nombre puede venir ya con el prefijo; evitar ir_frame_ir_frame_...
      const base = slug(name).replace(/-/g, '_').replace(/^ir_frame_?/, '');
      const symbol = `ir_frame_${base || 'code'}_${index}`;
      names.push({ symbol, name, length: result.microseconds.length });
      const { r, g, b } = result.quantized;
      lines.push(`/* ${name} — rgb(${r}, ${g}, ${b}) */`);
      lines.push(`static const uint16_t ${symbol}[] = {`);
      for (let i = 0; i < result.microseconds.length; i += 8) {
        lines.push(`  ${result.microseconds.slice(i, i + 8).join(', ')},`);
      }
      lines.push('};');
      lines.push('');
    });

    lines.push('typedef struct {');
    lines.push('  const char *name;');
    lines.push('  const uint16_t *timings;');
    lines.push('  uint16_t length;');
    lines.push('} ir_frame_code_t;');
    lines.push('');
    lines.push('static const ir_frame_code_t ir_frame_codes[] = {');
    for (const entry of names) {
      lines.push(`  { "${entry.name.replace(/"/g, '\\"')}", ${entry.symbol}, ${entry.length} },`);
    }
    lines.push('};');
    lines.push('');
    lines.push('#endif /* IR_FRAME_CODES_H */');
    return lines.join('\n');
  }

  const FORMATS = {
    txt: { label: 'Texto', ext: 'txt', mime: 'text/plain', build: toText },
    json: { label: 'JSON', ext: 'json', mime: 'application/json', build: toJson },
    ir: { label: 'Flipper Zero', ext: 'ir', mime: 'text/plain', build: toFlipper },
    h: { label: 'Cabecera C', ext: 'h', mime: 'text/plain', build: toCHeader },
  };

  /** Genera el archivo y dispara la descarga en el navegador. */
  function download(formatKey, entries, basename) {
    const format = FORMATS[formatKey];
    if (!format) throw new Error(`Formato desconocido: ${formatKey}`);
    if (!entries.length) throw new Error('No hay nada que exportar');

    const blob = new Blob([format.build(entries)], {
      type: `${format.mime};charset=utf-8`,
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${slug(basename)}.${format.ext}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return { FORMATS, download, slug, toText, toJson, toFlipper, toCHeader };
})();
