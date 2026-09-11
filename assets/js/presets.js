/*
 * Catálogo de presets agrupados por categoría.
 *
 * Los de la categoría "documentados" son los 25 valores RGB que aparecen
 * publicados en la documentación comunitaria del protocolo, con los
 * identificadores P_PULSO_xx que usan esas fuentes. Aquí solo se reproducen a
 * partir de esa documentación; sirven además como fixtures, porque generar uno
 * debe dar la trama documentada.
 *
 * El resto son composiciones propias construidas con el comando configurable
 * de 9 bytes, cuya semántica sí está documentada campo a campo.
 */

const PRESETS = [
  {
    id: 'documentados',
    name: 'Colores documentados',
    blurb:
      'Los 25 valores RGB publicados en la documentación comunitaria del ' +
      'protocolo, con los identificadores P_PULSO_xx que usan esas fuentes. ' +
      'Son pulsos cortos de 6 bytes y la referencia de compatibilidad más fiable.',
    items: [
      { name: 'Rojo', color: [240, 32, 0], note: 'P_PULSO_00' },
      { name: 'Naranja', color: [240, 80, 0], note: 'P_PULSO_01' },
      { name: 'Naranja oscuro', color: [184, 68, 0], note: 'P_PULSO_02' },
      { name: 'Amarillo dorado', color: [228, 188, 0], note: 'P_PULSO_03' },
      { name: 'Ámbar', color: [228, 148, 0], note: 'P_PULSO_04' },
      { name: 'Oliva', color: [184, 188, 0], note: 'P_PULSO_05' },
      { name: 'Verde', color: [16, 208, 0], note: 'P_PULSO_06' },
      { name: 'Verde claro', color: [132, 240, 92], note: 'P_PULSO_07' },
      { name: 'Verde menta', color: [104, 240, 160], note: 'P_PULSO_08' },
      { name: 'Cian', color: [52, 240, 252], note: 'P_PULSO_09' },
      { name: 'Azul cielo', color: [16, 148, 220], note: 'P_PULSO_10' },
      { name: 'Azul', color: [72, 12, 252], note: 'P_PULSO_11' },
      { name: 'Morado', color: [136, 56, 252], note: 'P_PULSO_12' },
      { name: 'Púrpura', color: [184, 12, 220], note: 'P_PULSO_13' },
      { name: 'Ciruela', color: [132, 12, 92], note: 'P_PULSO_14' },
      { name: 'Frambuesa', color: [228, 56, 92], note: 'P_PULSO_15' },
      { name: 'Fucsia', color: [204, 12, 92], note: 'P_PULSO_16' },
      { name: 'Rosa', color: [236, 116, 160], note: 'P_PULSO_17' },
      { name: 'Melocotón', color: [240, 156, 92], note: 'P_PULSO_18' },
      { name: 'Salmón', color: [240, 116, 92], note: 'P_PULSO_19' },
      { name: 'Lavanda', color: [184, 148, 252], note: 'P_PULSO_20' },
      { name: 'Verde lima', color: [204, 240, 92], note: 'P_PULSO_21' },
      { name: 'Azul pálido', color: [184, 208, 252], note: 'P_PULSO_22' },
      { name: 'Violeta', color: [184, 12, 252], note: 'P_PULSO_23' },
      { name: 'Magenta', color: [240, 52, 252], note: 'P_PULSO_24' },
    ].map(item => ({ ...item, mode: 'short' })),
  },
  {
    id: 'basicos',
    name: 'Colores base',
    blurb:
      'Primarios y secundarios en el máximo que el badge puede representar. ' +
      'Cada canal llega hasta 252, no 255, porque solo se transmiten 6 bits.',
    items: [
      { name: 'Rojo pleno', color: [252, 0, 0] },
      { name: 'Verde pleno', color: [0, 252, 0] },
      { name: 'Azul pleno', color: [0, 0, 252] },
      { name: 'Cyan', color: [0, 252, 252] },
      { name: 'Magenta', color: [252, 0, 252] },
      { name: 'Amarillo', color: [252, 252, 0] },
      { name: 'Blanco', color: [252, 252, 252] },
      { name: 'Blanco cálido', color: [252, 180, 108] },
      { name: 'Blanco frío', color: [216, 236, 252] },
      { name: 'Apagado', color: [0, 0, 0], note: 'Corta el efecto en curso' },
    ].map(item => ({ ...item, mode: 'short' })),
  },
  {
    id: 'envolventes',
    name: 'Envolventes',
    blurb:
      'Mismo color, distinta forma temporal. Demuestran cómo attack, sustain ' +
      'y release cambian por completo la percepción del efecto.',
    items: [
      {
        name: 'Destello',
        color: [252, 252, 252],
        mode: 'configurable',
        attack: 0,
        sustain: 1,
        release: 1,
        note: 'Ataque instantáneo, 32 ms de sostén',
      },
      {
        name: 'Pulso corto',
        color: [252, 80, 0],
        mode: 'configurable',
        attack: 1,
        sustain: 2,
        release: 2,
        note: '32 / 96 / 96 ms',
      },
      {
        name: 'Respiración',
        color: [0, 140, 252],
        mode: 'configurable',
        attack: 5,
        sustain: 4,
        release: 5,
        note: '960 ms de subida y bajada',
      },
      {
        name: 'Fundido lento',
        color: [180, 0, 252],
        mode: 'configurable',
        attack: 6,
        sustain: 5,
        release: 6,
        note: '2.4 s de subida, casi 4.4 s en total',
      },
      {
        name: 'Onda larga',
        color: [0, 252, 180],
        mode: 'configurable',
        attack: 7,
        sustain: 6,
        release: 7,
        note: 'El envolvente más largo posible',
      },
      {
        name: 'Golpe seco',
        color: [252, 0, 60],
        mode: 'configurable',
        attack: 0,
        sustain: 0,
        release: 1,
        note: 'Sustain 0: apenas un parpadeo',
      },
      {
        name: 'Brasa',
        color: [252, 100, 0],
        mode: 'configurable',
        attack: 4,
        sustain: 6,
        release: 6,
        note: 'Sube en 480 ms y se apaga muy despacio',
      },
      {
        name: 'Latido',
        color: [252, 0, 0],
        mode: 'configurable',
        attack: 1,
        sustain: 1,
        release: 3,
        note: 'Corto y con cola',
      },
    ],
  },
  {
    id: 'multitud',
    name: 'Efectos de multitud',
    blurb:
      'Usan el campo chance: todos los badges reciben el mismo comando, pero ' +
      'solo una fracción aleatoria lo ejecuta. De ahí salen los efectos de ' +
      'chispeo sobre un público entero.',
    items: [
      {
        name: 'Chispeo denso',
        color: [252, 252, 252],
        mode: 'configurable',
        attack: 0,
        sustain: 1,
        release: 2,
        chance: 2,
        note: '67 % de los dispositivos',
      },
      {
        name: 'Chispeo medio',
        color: [252, 236, 180],
        mode: 'configurable',
        attack: 0,
        sustain: 1,
        release: 2,
        chance: 3,
        note: '50 %',
      },
      {
        name: 'Chispeo disperso',
        color: [180, 220, 252],
        mode: 'configurable',
        attack: 0,
        sustain: 1,
        release: 3,
        chance: 5,
        note: '16 %',
      },
      {
        name: 'Estrellas raras',
        color: [252, 252, 216],
        mode: 'configurable',
        attack: 1,
        sustain: 2,
        release: 4,
        chance: 7,
        note: '4 %, puntos aislados en la multitud',
      },
      {
        name: 'Lluvia azul',
        color: [0, 120, 252],
        mode: 'configurable',
        attack: 1,
        sustain: 2,
        release: 4,
        chance: 4,
        note: '32 %, envolvente suave',
      },
      {
        name: 'Ascuas dispersas',
        color: [252, 60, 0],
        mode: 'configurable',
        attack: 2,
        sustain: 4,
        release: 5,
        chance: 6,
        note: '10 %, muy lento',
      },
    ],
  },
  {
    id: 'escenas',
    name: 'Escenas',
    blurb:
      'Paletas coherentes pensadas para lanzarse en secuencia. Descarga la ' +
      'categoría completa para tener todos los colores de la escena juntos.',
    items: [
      { name: 'Atardecer · 1', color: [252, 120, 0], mode: 'configurable', attack: 3, sustain: 5, release: 5 },
      { name: 'Atardecer · 2', color: [252, 60, 40], mode: 'configurable', attack: 3, sustain: 5, release: 5 },
      { name: 'Atardecer · 3', color: [180, 20, 80], mode: 'configurable', attack: 3, sustain: 5, release: 5 },
      { name: 'Océano · 1', color: [0, 100, 180], mode: 'configurable', attack: 4, sustain: 5, release: 5 },
      { name: 'Océano · 2', color: [0, 180, 200], mode: 'configurable', attack: 4, sustain: 5, release: 5 },
      { name: 'Océano · 3', color: [0, 60, 140], mode: 'configurable', attack: 4, sustain: 5, release: 5 },
      { name: 'Bosque · 1', color: [20, 160, 40], mode: 'configurable', attack: 4, sustain: 5, release: 5 },
      { name: 'Bosque · 2', color: [120, 200, 0], mode: 'configurable', attack: 4, sustain: 5, release: 5 },
      { name: 'Neón · 1', color: [252, 0, 200], mode: 'configurable', attack: 0, sustain: 2, release: 2 },
      { name: 'Neón · 2', color: [0, 252, 220], mode: 'configurable', attack: 0, sustain: 2, release: 2 },
      { name: 'Neón · 3', color: [200, 252, 0], mode: 'configurable', attack: 0, sustain: 2, release: 2 },
      { name: 'Hielo · 1', color: [200, 240, 252], mode: 'configurable', attack: 2, sustain: 4, release: 4 },
      { name: 'Hielo · 2', color: [120, 200, 252], mode: 'configurable', attack: 2, sustain: 4, release: 4 },
    ],
  },
  {
    id: 'grupos',
    name: 'Grupos',
    blurb:
      'El mismo color restringido a distintos group id. Solo los badges de ese ' +
      'grupo reaccionan; el grupo 0 es broadcast y responde siempre.',
    items: [
      { name: 'Broadcast', color: [252, 252, 252], mode: 'configurable', attack: 1, sustain: 3, release: 2, restrictGroupId: 0, note: 'Grupo 0: todos' },
      { name: 'Grupo 1 · rojo', color: [252, 0, 0], mode: 'configurable', attack: 1, sustain: 3, release: 2, restrictGroupId: 1 },
      { name: 'Grupo 2 · verde', color: [0, 252, 0], mode: 'configurable', attack: 1, sustain: 3, release: 2, restrictGroupId: 2 },
      { name: 'Grupo 3 · azul', color: [0, 0, 252], mode: 'configurable', attack: 1, sustain: 3, release: 2, restrictGroupId: 3 },
      { name: 'Grupo 4 · ámbar', color: [252, 160, 0], mode: 'configurable', attack: 1, sustain: 3, release: 2, restrictGroupId: 4 },
    ],
  },
];

/** Normaliza un item de preset al objeto de efecto que consume el codificador. */
function presetToEffect(item) {
  const [r, g, b] = item.color;
  return {
    color: { r, g, b },
    mode: item.mode || 'short',
    attack: item.attack ?? 0,
    sustain: item.sustain ?? 3,
    release: item.release ?? 1,
    chance: item.chance ?? 0,
    restrictGroupId: item.restrictGroupId ?? 0,
    repeatEnabled: item.repeatEnabled ?? false,
    onStart: item.onStart ?? false,
    useGlobalSustain: item.useGlobalSustain ?? false,
  };
}
