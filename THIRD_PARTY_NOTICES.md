# Avisos de terceros / Third-party notices

Este proyecto es una implementación independiente escrita a partir de
documentación pública de protocolo. **No se ha copiado código fuente de los
proyectos citados abajo.** Aun así, el conocimiento del protocolo procede
enteramente de su trabajo, y sus avisos de licencia se reproducen aquí de forma
íntegra en reconocimiento de esa autoría.

This project is an independent implementation written from public protocol
documentation. **No source code from the projects below has been copied.** The
protocol knowledge nevertheless comes entirely from their work, and their
license notices are reproduced here in full in acknowledgement of that authorship.

---

## 1. PixMob_IR — jamesw343 (James Wang)

- Repositorio: https://github.com/jamesw343/PixMob_IR
- Documentación de protocolo: https://github.com/jamesw343/PixMob_IR/blob/master/docs/ir_protocol.md
- Licencia: MIT

**Qué se deriva de este trabajo** (datos de protocolo documentados, no código):

- La tabla de sustitución de 64 entradas.
- El algoritmo de checksum (suma de 8 bits sobre bytes ya sustituidos, seis bits
  altos, reindexado por la tabla).
- Los layouts de comando de 6 y 9 bytes, el magic `0x80` y la disposición de
  campos por offset.
- El significado de los bits de flags (`gsten`, `type`, `onstrt`).
- El orden de canal G/R/B y la cuantización a 6 bits por canal.
- Las tablas de attack/sustain/release, `chance` y GST.
- La serialización LSB-first.

```
MIT License

Copyright (c) 2024-2025 James Wang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. pixmob-ir-reverse-engineering — danielweidman (Dani Weidman)

- Repositorio: https://github.com/danielweidman/pixmob-ir-reverse-engineering
- Licencia: MIT

**Qué se deriva de este trabajo** (hallazgos de investigación, no código):

- La caracterización de la capa física: portadora de ≈38 kHz y celda temporal
  de ≈694.44 µs.
- La identificación del separador `1000000000` entre comandos repetidos.
- Los valores `P_PULSO` publicados por este proyecto, de los que proceden los 25
  RGB de la categoría de presets «Colores documentados» y las duraciones Pronto
  usadas como fixture de verificación.
- La observación de que el destello visible de medio segundo es temporización
  interna del dispositivo y no la duración de la transmisión.

```
MIT License

Copyright (c) 2022 Dani Weidman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. Otras referencias citadas

Estas fuentes se citan como referencia documental. No se incorpora código,
firmware ni material extraído de ninguna de ellas.

| Fuente | Uso en este proyecto |
|---|---|
| [Patente US-10863607-B2](https://patents.google.com/patent/US10863607B2/en) | Referencia pública para el contexto técnico y la temporización nominal. Citada, no implementada a partir de sus reivindicaciones. |
| [FCC ID 2ADS4WASH](https://fccid.io/2ADS4WASH) | Documentación pública del transmisor y longitud de onda de 940 nm. |

Este repositorio **no** contiene ni redistribuye firmware extraído, volcados de
memoria, binarios propietarios ni ningún material bajo copyright del fabricante.

## 4. Marcas

PixMob es una marca de su titular (Eski Inc.). Se menciona aquí únicamente de
forma descriptiva, para identificar el hardware con el que este software
pretende interoperar. Este proyecto no está afiliado, patrocinado ni respaldado
por dicho titular, y no utiliza sus logotipos ni su identidad visual.

PixMob is a trademark of its owner (Eski Inc.), referenced here descriptively
only, to identify the hardware this software aims to interoperate with. This
project is not affiliated with, sponsored by, or endorsed by that owner, and
uses none of its logos or visual identity.
