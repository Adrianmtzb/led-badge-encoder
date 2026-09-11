## Qué cambia

<!-- Una o dos frases. Si corrige una issue: "Cierra #123". -->

## Por qué

<!-- Qué problema resuelve. Si es un cambio visual, adjunta capturas en claro y oscuro. -->

## Tipo de cambio

- [ ] Corrección de un fallo
- [ ] Función nueva
- [ ] Cambio en la codificación o decodificación del protocolo
- [ ] Interfaz o accesibilidad
- [ ] Documentación
- [ ] Presets

## Verificación

- [ ] `node tests/run.js` pasa
- [ ] La autocomprobación de la pestaña *Protocolo* pasa en el navegador
- [ ] Sin errores en la consola
- [ ] Revisado en tema claro y oscuro
- [ ] Revisado a 390 px de ancho, sin desbordamiento horizontal
- [ ] Navegable con teclado

## Procedencia

- [ ] El código es propio, o adaptado de fuentes citadas e identificadas abajo
- [ ] No incluye firmware extraído, volcados de memoria ni binarios del fabricante
- [ ] Si aporta conocimiento de protocolo nuevo, la fuente está en `THIRD_PARTY_NOTICES.md`, en el README y en `#creditos` de `index.html`
- [ ] Acepto que la aportación se publique bajo la licencia MIT del proyecto

<!-- Si has adaptado código ajeno, indica aquí el origen exacto y su licencia. -->

## Alcance

- [ ] No añade comandos que escriban EEPROM, cambien group id, alteren configuración persistente ni reseteen dispositivos
- [ ] No añade transmisión desde la página ni integración con emisores en red
- [ ] Los presets nuevos, si los hay, usan nombres genéricos: sin artistas, giras, recintos ni eventos

<!-- Ver CONTRIBUTING.md, sección 1, si alguna de estas casillas te bloquea. -->

## Cambios en el protocolo

<!-- Solo si tocas assets/js/protocol.js de forma que cambien los bytes generados.
     Hace falta la referencia documental (repositorio, archivo, sección) o una
     captura real con el Pronto Hex y el comportamiento observado del badge.
     Borra esta sección si no aplica. -->
