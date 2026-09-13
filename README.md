# Unofficial PixMob-compatible IR Frame Generator

Herramienta de investigación independiente, desarrollada por la comunidad, para
**interoperabilidad, preservación y control de dispositivos propios**.

Convierte un color y unos parámetros de efecto en **Pronto Hex**, y en sentido
inverso interpreta una captura Pronto y la traduce de vuelta a color, envolvente,
probabilidad y grupo.

Sitio estático sin dependencias ni build: todo el cálculo ocurre en el navegador
y no se envía nada a ningún servidor.

**Código abierto bajo [licencia MIT](LICENSE).** El código fuente completo está
en este repositorio, sin build ni minificación: lo que se publica es lo que se
lee. Las aportaciones son bienvenidas — ver [CONTRIBUTING.md](CONTRIBUTING.md).

---

## ⚠️ Aviso

**No oficial. No comercial. Sin afiliación.** Este proyecto no está afiliado,
patrocinado ni respaldado por PixMob ni por Eski Inc. No reproduce ninguna
especificación oficial y no garantiza compatibilidad con ningún dispositivo.
PixMob es una marca de su titular, mencionada aquí de forma puramente
descriptiva para identificar el hardware con el que este software pretende
interoperar.

### Uso aceptable

```
Úsala solo con dispositivos que poseas o tengas permiso para probar.
No la uses en eventos en directo, ni para interferir con espectáculos,
equipamiento de recintos o dispositivos de terceros.
```

El infrarrojo requiere línea de vista, pero un emisor potente puede alcanzar
muchos dispositivos a la vez. La página nunca transmite nada por sí misma:
genera datos y tú decides qué hacer con ellos.

### Comandos deliberadamente no implementados

El protocolo documenta más comandos de los que esta herramienta genera. Se han
dejado fuera a propósito los que escriben memoria persistente o alteran el estado
interno de un dispositivo: escritura de perfiles en EEPROM, asignación y cambio
de group id, configuración persistente de `repeat count` / `repeat delay` / GST,
y comandos de reset.

Los únicos campos que rozan estado guardado (`onstrt` y `rpen`) están recogidos
bajo una sección **Avanzado** plegada y señalizada en el generador.

---

## Qué hace

**Generador** — selector de color con entrada hex, RGB numérico y sliders.
Muestra lado a lado el color solicitado y el que realmente recibe el badge,
porque el protocolo solo transmite 6 bits por canal.

- **Pulso corto** (6 bytes): el badge aplica su propia temporización.
- **Configurable** (9 bytes): attack, sustain, release, probabilidad y
  restricción de grupo, con los tiempos reales en milisegundos y una vista
  previa de la forma del envolvente.
- Opciones de transmisión: preset de temporización, portadora, repeticiones,
  gap final y separador.

**Presets** — 67 comandos en seis categorías, todos codificados en vivo. La
categoría *Colores documentados* reproduce los 25 valores RGB publicados en la
documentación comunitaria del protocolo y sirve de referencia de
compatibilidad. Cada categoría se descarga completa en cualquiera de los
formatos.

**Analizador** — pega una captura Pronto Hex y obtén portadora, pares, celda T
estimada, gap, bitstream reconstruido, alineación de padding, verificación de
checksum y los campos del comando decodificado.

**Secuenciador** — coloca comandos en pistas y reprodúcelos como un show, con
línea de tiempo, zoom, ajuste a rejilla y bucle.

- Los canales son los **grupos del protocolo** (`restrict group id`, 5 bits). El
  primero es la difusión, grupo 0, que llega a todos los badges; los demás usan
  un grupo del 1 al 31 y solo los ejecutan los badges asignados a él. El grupo de
  un badge vive en su memoria interna, y asignarlo exige un comando que escribe
  esa memoria: este proyecto **no lo implementa ni va a implementarlo**, igual
  que el resto de comandos que alteran la configuración de un aparato. No es un
  pendiente, es una decisión. Consecuencia práctica: **un badge sin grupo
  asignado responde a todos los canales**, así que con badges de fábrica se
  encenderá con el show entero y no solo con la difusión. Separar canales por
  grupo únicamente funciona con badges a los que ya se les asignó uno. El grupo
  lo pone el canal, no el clip, así que arrastrar un clip a otra pista cambia a
  quién va dirigido.
- Cada clip se edita en un panel flotante anclado a él: color, efecto, ataque,
  sostén, relajación y **probabilidad**. Un botón «Probar» lo emite al instante
  por la salida elegida, sin reproducir el show.
- El secuenciador emite **solo el comando configurable de 9 bytes**, con todos
  los tiempos dentro de la trama, y nunca los campos que leen o escriben la
  memoria del badge (`gsten`, arranque y repetición). Así el mismo show suena
  igual en cualquier aparato. El comando corto de 6 bytes sigue estando en el
  protocolo y en la pestaña del generador. Por debajo del
  100 % cada badge decide por su cuenta si ejecuta el comando, que es lo que
  produce el efecto disperso en un grupo grande.
- Los clips dibujan su envolvente encima, para reconocer de un vistazo qué hay
  en cada sitio.
- Los clips se duplican, se **distribuyen** a intervalos regulares hasta un
  límite, se arrastran entre pistas y se eliminan con el botón derecho; el
  borrado se deshace desde el aviso o con `Ctrl`/`Cmd`+`Z`.
- El trabajo se **autoguarda como sesión en el navegador** y al abrir la pestaña
  vuelve la última. Hay varias sesiones, con su fecha y su número de clips, que
  se eligen, se renombran y se eliminan; «Empezar de cero» descarta la actual.
  Todo vive en `localStorage`, con el mismo formato que el archivo del show. La
  **pista de audio no se guarda** —es un archivo del navegador—: solo se recuerda
  su nombre para poder volver a seleccionarla.
- Los controles que tocan la línea de tiempo —transporte, reloj, rebobinado,
  zoom, ajuste a rejilla y pantalla completa— van en una fila fija pegada a ella;
  «+ Canal» está al pie de la columna de cabeceras. Lo demás —sesión, salida y
  archivo del show— se reparte en pestañas dentro del panel de ajustes, y la
  pestaña abierta se recuerda con la sesión, como el zoom. Reproducir con el
  cabezal en el final rebobina y arranca; rebobinar lleva el cabezal al principio
  sin detener. El registro de emisión se pliega y su estado también se recuerda.
- Los shows se guardan y se cargan en `.json`, también sin salir del navegador.
  Un archivo del formato anterior, sin grupos de canal, se abre asignándolos por
  orden y avisando de ello.
- **Previsualización de la envolvente**: los indicadores de canal y la vista de
  conjunto recorren los tiempos reales de las tablas del protocolo. Es
  aproximada; hay dos casos que el badge resuelve con su estado interno.
- **Pista de audio** opcional para colocar los comandos sobre los golpes. El
  archivo se decodifica en el navegador y **no se sube a ningún sitio**.
- Salidas: emulación local, que codifica pero no transmite, y envío por HTTP a
  un dispositivo propio. Esto último exige servir la página en local y que el
  firmware conteste al preflight; desde el sitio publicado en HTTPS el navegador
  lo bloquea por contenido mixto.

**Protocolo** — explicación del pipeline, tablas de tiempos, limitaciones,
fuentes y una batería de comprobaciones que se ejecuta en cada carga.

## Formatos de descarga

| Formato | Uso |
|---|---|
| `.txt` | Pronto Hex más todas las capas intermedias, legible |
| `.json` | Estructurado, para consumir desde otro programa |
| `.ir` | Señales raw de Flipper Zero |
| `.h` | Cabecera C con arrays de timings para Arduino / ESP32 |

## Publicar en GitHub Pages

No hay build. Sube el repositorio y activa Pages:

1. **Settings → Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `main`, carpeta `/ (root)`

El archivo `.nojekyll` evita que Jekyll procese el sitio.

Para trabajar en local basta con servir la carpeta:

```bash
python3 -m http.server 8000
```

## Estructura

```
index.html
LICENSE
CONTRIBUTING.md
THIRD_PARTY_NOTICES.md
assets/css/styles.css
assets/js/protocol.js    tabla, checksum, comandos, bitstream, Pronto, decoder
assets/js/presets.js     catálogo de presets por categoría
assets/js/exporters.js   txt, json, .ir de Flipper, cabecera C
assets/js/sequencer.js   show, línea de tiempo y transporte del secuenciador
assets/js/app.js         interfaz del generador y del analizador
assets/js/sequencer-ui.js  interfaz del secuenciador
tests/run.js             suite de verificación para Node, sin dependencias
.github/                 plantillas de PR e issues
```

`protocol.js` y `sequencer.js` no tocan el DOM y pueden reutilizarse tal cual en Node.

## Verificación

```bash
node tests/run.js
```

28 comprobaciones sin dependencias, sobre los mismos archivos que sirve la web:
vectores documentados, tabla de sustitución, cuantización de color, estructura de
comandos de 6 y 9 bytes, bitstream, Pronto Hex, los 67 presets y los cuatro
formatos de exportación.

Una batería reducida se ejecuta además en cada carga de la página y se muestra en
la pestaña *Protocolo*:

- `rgb(0, 252, 192)` produce los bytes `80 5A 21 26 21 5A`.
- Su bitstream recortado son los 40 bits documentados.
- La tabla de sustitución tiene 64 valores únicos y es reversible.
- La trama documentada `P_PULSO_00` se reproduce word por word.
- Un comando de 9 bytes conserva todos sus campos al ir y volver.
- Alterar un solo byte invalida el frame.

## Contribuir

Las aportaciones son bienvenidas. [CONTRIBUTING.md](CONTRIBUTING.md) explica el
alcance del proyecto (qué se acepta y qué no), las reglas de procedencia del
código, el requisito de respaldo documental para cambios de protocolo y cómo
ejecutar todo en local.

En resumen: sin build ni dependencias, `protocol.js` no toca el DOM,
`node tests/run.js` tiene que seguir pasando, y no entran comandos que escriban
memoria persistente ni presets con nombres de eventos o artistas.

## Limitaciones

- El protocolo procede de análisis comunitario de firmware y pruebas físicas.
  No es una especificación oficial.
- Hay diferencias entre generaciones de hardware y firmware, y algunos badges
  conservan configuración previa en EEPROM.
- Varios campos siguen parcialmente investigados, entre ellos `gsten` y algunas
  ramas de sustain y release.
- El resultado visible depende de batería, LEDs, difusor y ambiente. Un RGB
  numérico no garantiza coincidencia exacta entre modelos.
- Los protocolos RF y BLE son distintos y no están cubiertos aquí.
- Una trama correcta puede no funcionar si falla el emisor: intensidad IR,
  driver, polaridad o timing.

## Licencia y atribución

Este es un proyecto de **código abierto**. El código propio de este repositorio
se publica bajo [licencia MIT](LICENSE): puedes usarlo, modificarlo y
redistribuirlo, conservando el aviso de copyright.

Este proyecto es una **implementación independiente** escrita a partir de
documentación pública de protocolo. **No contiene código copiado** de otros
proyectos, ni firmware extraído, ni volcados de memoria, ni binarios del
fabricante. Aun así, el conocimiento del protocolo procede enteramente del
trabajo de otras personas, publicado bajo MIT:

| Proyecto | Licencia | Qué se deriva de él |
|---|---|---|
| [PixMob_IR](https://github.com/jamesw343/PixMob_IR) | MIT © 2024-2025 James Wang | Tabla de sustitución, checksum, layouts de 6 y 9 bytes, flags, tablas de tiempos, orden G/R/B, LSB-first |
| [pixmob-ir-reverse-engineering](https://github.com/danielweidman/pixmob-ir-reverse-engineering) | MIT © 2022 Dani Weidman | Capa física (≈38 kHz, celda ≈694.44 µs), separador, valores `P_PULSO` publicados |

Los avisos de licencia completos están en
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Patentes

Existe al menos una patente relacionada con el sistema, citada como referencia
técnica en la documentación: [US-10863607-B2](https://patents.google.com/patent/US10863607B2/en).
Se menciona aquí por transparencia. Este repositorio no ofrece ninguna opinión
legal al respecto y no implementa nada a partir de sus reivindicaciones.

### Reclamaciones

Si representas a un titular de derechos y consideras que algo de este
repositorio debe corregirse o retirarse, abre una issue y se atenderá. La
intención es documentar e interoperar, no competir ni perjudicar a nadie.

## Fuentes

Todo el conocimiento del protocolo procede del trabajo público de otras
personas. Este proyecto solo lo implementa.

1. Daniel Weidman — [PixMob IR (and RF!) Reverse Engineering Project](https://github.com/danielweidman/pixmob-ir-reverse-engineering)
   Investigación original del protocolo, publicada por sus autores: análisis de señal, timings y herramientas.
2. jamesw343 — [PixMob_IR, documentación del protocolo IR](https://github.com/jamesw343/PixMob_IR/blob/master/docs/ir_protocol.md)
   Fuente principal de layouts, flags, tabla de sustitución, checksum y serialización.
3. jamesw343 — [PixMob_IR, implementación de referencia](https://github.com/jamesw343/PixMob_IR)
4. Patente [US-10863607-B2](https://patents.google.com/patent/US10863607B2/en) — contexto técnico y celda de 694.44 µs.
5. [FCC ID 2ADS4WASH](https://fccid.io/2ADS4WASH) — documentación pública del transmisor, 940 nm.

Esta implementación se basa exclusivamente en esa documentación pública.
