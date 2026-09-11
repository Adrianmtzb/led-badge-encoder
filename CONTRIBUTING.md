# Contribuir

Gracias por el interés. Este es un proyecto de código abierto bajo
[licencia MIT](LICENSE), y las aportaciones son bienvenidas.

Antes de abrir una pull request conviene leer estas páginas: casi todo lo que se
rechaza aquí se rechaza por el alcance del proyecto, no por la calidad del
código.

---

## 1. Alcance

Esta herramienta existe para **interoperabilidad, preservación y control de
dispositivos propios**. Ese enfoque no es decorativo: determina qué se acepta.

### Se acepta

- Correcciones de codificación o decodificación respaldadas por documentación
  pública del protocolo.
- Mejoras de interfaz, accesibilidad y rendimiento.
- Formatos de exportación adicionales para hardware de aficionado.
- Documentación, traducciones y aclaraciones del protocolo.
- Presets con nomenclatura genérica y descriptiva.

### No se acepta

| Aportación | Motivo |
|---|---|
| Comandos que escriben EEPROM, asignan group id, cambian configuración persistente o resetean un dispositivo | Alteran el estado de hardware ajeno de forma no trivialmente reversible. Ver *Comandos deliberadamente no implementados* en el [README](README.md#comandos-deliberadamente-no-implementados) |
| Transmisión desde la propia página, o cualquier integración con emisores en red | La página genera datos y nada más; quien transmite es la persona usuaria, con su propio equipo |
| Presets con nombres de artistas, giras, recintos o eventos | Posiciona la herramienta como orientada a eventos en directo, que es justo el uso que se desaconseja |
| Funciones de barrido, fuerza bruta o difusión masiva | Solo tienen sentido contra dispositivos que no son tuyos |
| Código copiado de otros proyectos | Ver la sección 2 |
| Firmware extraído, volcados de memoria o binarios del fabricante | No se redistribuyen bajo ninguna forma, ni siquiera parcial o codificada |
| Logotipos, tipografías o identidad visual de terceros | El proyecto no debe parecer oficial |

Si dudas de si algo encaja, abre una issue antes de escribir el código.

## 2. Procedencia del código

Este repositorio es una **implementación independiente** escrita a partir de
documentación pública de protocolo. Esa afirmación aparece en el README, en
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) y en la propia web, así que
tiene que seguir siendo cierta.

- **No pegues código de otros proyectos**, aunque sean MIT. Implementa a partir
  de la documentación. Si por alguna razón hace falta adaptar código ajeno,
  dilo de forma explícita en la PR, identifica el origen exacto y actualiza
  `THIRD_PARTY_NOTICES.md` antes de que se revise.
- Si aportas conocimiento de protocolo procedente de una fuente que aún no está
  citada, añádela a `THIRD_PARTY_NOTICES.md`, a la sección *Fuentes* del README
  y a `#creditos` en `index.html`. Las tres listas deben coincidir.
- Al enviar una PR confirmas que tienes derecho a aportar ese contenido y que se
  publica bajo la licencia MIT del proyecto.

## 3. Cambios en el protocolo

Un cambio en `assets/js/protocol.js` que altere los bytes generados necesita
respaldo. En la PR, una de estas dos cosas:

- La referencia concreta a la documentación (repositorio, archivo y sección), o
- una captura real: el Pronto Hex, con qué se capturó y qué hizo el badge.

«Lo he probado y parece que va mejor» no es suficiente para tocar la
codificación: es la capa que nadie más puede verificar a posteriori.

Los vectores de `tests/run.js` (bytes `80 5A 21 26 21 5A`, los 40 bits
documentados y la trama `P_PULSO_00`) son innegociables. Si tu cambio los
rompe, el cambio está mal, salvo que aportes una fuente pública que demuestre
que los vectores estaban mal.

## 4. Ejecutar el proyecto

No hay build, ni dependencias, ni `package.json`.

```bash
# servir la web
python3 -m http.server 8000   # http://localhost:8000

# verificación del protocolo (requiere Node, sin instalar nada)
node tests/run.js
```

`tests/run.js` carga los mismos archivos que sirve la web, así que prueba
exactamente lo que se publica. Debe terminar con `28/28 comprobaciones pasan` y
código de salida 0. Si añades comportamiento, añade su comprobación.

La pestaña *Protocolo* de la web ejecuta además una batería reducida en cada
carga; también debe seguir en verde.

## 5. Estilo

- **JavaScript vanilla**, sin build, sin dependencias, sin frameworks. Es una
  restricción deliberada: el sitio debe seguir funcionando abriendo un archivo.
- **Separación de capas**, que es lo que hace verificable el proyecto:

  | Archivo | Responsabilidad |
  |---|---|
  | `assets/js/protocol.js` | Codificación, decodificación, Pronto. **No toca el DOM** y debe seguir siendo utilizable desde Node |
  | `assets/js/presets.js` | Catálogo de presets. Solo datos |
  | `assets/js/exporters.js` | Serialización a `.txt`, `.json`, `.ir`, `.h` |
  | `assets/js/app.js` | Interfaz. Todo el DOM vive aquí |

- Los comentarios explican **por qué**, no qué. Un comentario que parafrasea la
  línea siguiente sobra; uno que explica una constante rara como
  `CAPTURE_CELL_UNITS = 26.5` es imprescindible.
- Indentación de 2 espacios, comillas simples, punto y coma.
- Texto de interfaz y comentarios en español, igual que el resto del código.
- CSS con los tokens ya definidos en `:root`. Todo cambio visual debe verse bien
  en claro y en oscuro.

## 6. Antes de abrir la PR

- `node tests/run.js` pasa.
- La autocomprobación de la pestaña *Protocolo* pasa.
- Sin errores en la consola del navegador.
- Revisado en claro y en oscuro.
- Revisado a 390 px de ancho, sin desbordamiento horizontal.
- Navegable con teclado: foco visible y orden coherente.

La plantilla de PR recoge esta lista.

## 7. Issues

- **Fallos**: qué esperabas, qué pasó, navegador, y el Pronto Hex implicado si
  lo hay.
- **Hallazgos de protocolo**: la fuente o la captura, siempre.
- **Reclamaciones de titulares de derechos**: abre una issue y se atenderá. La
  intención del proyecto es documentar e interoperar, no competir ni perjudicar
  a nadie.

## 8. Conducta

Trata bien a la gente. Se moderará cualquier comportamiento hostil, y también
cualquier intento de usar las issues para coordinar el uso de la herramienta en
eventos en directo.
