// Shot list of the presentation film. Times are seconds; positions in scene metres
// (north = +Z, west = +X). Every shot overlaps the next by OVERLAP seconds (dissolve).
//
// keys: camera keyframes with normalised time t in [0, 1]; pos / look are world
// positions, or offsets from a moving subject when `track` is set:
//   track 'pal'  — the god's palanquin, 'head' — the head of the procession.
// orbit: { center, radius, height, a0, a1 } (degrees, 0 = north, 90 = west).

const OVERLAP = 1.0;

const shots = [
  {
    id: 'title', dur: 9, time: 'golden', proc: 120, warm: 2, ease: 'inout',
    keys: [
      { t: 0, pos: [-34, 64, 318], look: [60, 34, -520], fov: 40 },
      { t: 0.55, pos: [-28, 60, 300], look: [30, 18, -200], fov: 40 },
      { t: 1, pos: [-22, 56, 284], look: [0, 6, 50], fov: 40 },
    ],
    overlay: 'title',
  },
  {
    id: 'way', dur: 12, time: 'golden', proc: 120, warm: 2, ease: 'inout',
    keys: [
      { t: 0, pos: [-4, 36, 250], look: [0, 6, 130], fov: 44 },
      { t: 0.45, pos: [-3.2, 23, 206], look: [0, 6, 100], fov: 44 },
      { t: 0.75, pos: [-2.8, 12, 178], look: [0, 7, 70], fov: 44 },
      { t: 1, pos: [-2.5, 6.5, 158], look: [0, 7, 40], fov: 44 },
    ],
    caption: { eyebrow: 'Babylon · 575 BCE', title: 'The Processional Way', sub: 'The sacred road runs 180 metres between glazed walls to the Ishtar Gate' },
  },
  {
    id: 'lions', dur: 11, time: 'golden', proc: 20, warm: 2, ease: 'linear',
    keys: [
      { t: 0, pos: [-8.3, 1.65, 136], look: [-11.2, 1.7, 130], fov: 40 },
      { t: 1, pos: [-8.3, 1.65, 119], look: [-11.2, 1.7, 113], fov: 40 },
    ],
    caption: { eyebrow: 'Moulded glazed brick', title: 'The Lions of Ishtar', sub: 'Sixty striding lions on each wall of the Processional Way' },
  },
  {
    id: 'follow', dur: 12, time: 'golden', proc: 62, warm: 3, ease: 'linear', track: 'pal',
    keys: [
      { t: 0, pos: [6.5, 1.9, 11], look: [-0.5, 1.8, -7], fov: 42 },
      { t: 1, pos: [4.6, 1.8, 6.5], look: [-0.5, 2.0, -9], fov: 42 },
    ],
    caption: { eyebrow: 'The New Year festival', title: 'The Akitu Procession', sub: 'The statue of the god is carried along the Processional Way' },
  },
  {
    id: 'headon', dur: 10, time: 'golden', proc: 70, warm: 3, ease: 'linear', track: 'head',
    keys: [
      { t: 0, pos: [4.8, 1.55, -7.5], look: [0.2, 1.6, 6], fov: 40 },
      { t: 1, pos: [3.9, 1.6, -5.5], look: [0.0, 1.7, 7], fov: 40 },
    ],
    caption: { eyebrow: 'Guards, standards, drums and lyres', title: 'Music for Marduk', sub: 'Priests with censers walk before the god' },
  },
  {
    id: 'people', dur: 10, time: 'golden', proc: 32, warm: 4, ease: 'linear',
    keys: [
      { t: 0, pos: [-4.4, 1.62, 48.5], look: [-9.6, 1.45, 46], fov: 36 },
      { t: 1, pos: [-4.4, 1.62, 42.5], look: [-9.6, 1.45, 40], fov: 36 },
    ],
    caption: { eyebrow: 'Townsfolk along the street', title: 'The People of Babylon', sub: 'Merchants, porters, elders and families watch the procession pass' },
  },
  {
    id: 'gate', dur: 12, time: 'golden', proc: 150, warm: 2, ease: 'inout',
    keys: [
      { t: 0, pos: [0, 1.75, 64], look: [0, 9.5, 0], fov: 42 },
      { t: 1, pos: [0, 2.3, 27], look: [0, 12.5, 0], fov: 48 },
    ],
    caption: { eyebrow: 'Nebuchadnezzar II', title: 'The Ishtar Gate', sub: 'Faced with cobalt-blue glazed brick, c. 575 BCE' },
  },
  {
    id: 'rise', dur: 10, time: 'golden', proc: 150, warm: 2, ease: 'inout',
    keys: [
      { t: 0, pos: [8.5, 1.8, 15], look: [4, 8, 0], fov: 46 },
      { t: 1, pos: [13, 25, 33], look: [0, 17, -20], fov: 46 },
    ],
  },
  {
    id: 'reliefs', dur: 11, time: 'golden', proc: 150, warm: 2, ease: 'linear',
    keys: [
      { t: 0, pos: [10.4, 5.6, 4.3], look: [9.6, 5.5, 0], fov: 40 },
      { t: 1, pos: [5.6, 5.6, 4.3], look: [4.8, 5.5, 0], fov: 40 },
    ],
    caption: { eyebrow: 'Sacred animals', title: 'Bulls and Dragons', sub: 'The aurochs of Adad and the mušḫuššu of Marduk' },
  },
  {
    id: 'passage', dur: 10, time: 'golden', proc: 150, warm: 2, ease: 'inout',
    keys: [
      { t: 0, pos: [0, 1.7, 8], look: [0, 3.0, -25], fov: 50 },
      { t: 1, pos: [0, 1.75, -28], look: [0, 2.8, -60], fov: 50 },
    ],
    caption: { eyebrow: 'Front gate · light-well · main gate', title: 'Into the City', sub: 'Fifty metres of glazed passages lead into Babylon' },
  },
  {
    id: 'city', dur: 12, time: 'golden', proc: 150, warm: 3, ease: 'inout',
    keys: [
      { t: 0, pos: [6.5, 1.9, -62], look: [18, 2.2, -73], fov: 46 },
      { t: 0.5, pos: [5, 7, -70], look: [-10, 3, -100], fov: 46 },
      { t: 1, pos: [2, 15, -78], look: [-70, 2, -120], fov: 46 },
    ],
    caption: { eyebrow: 'Beyond the gate', title: 'The Inner City', sub: 'Markets, courtyard houses, temples and palm gardens' },
  },
  {
    id: 'ziggurat', dur: 12, time: 'golden', proc: 150, warm: 2, ease: 'inout',
    keys: [
      { t: 0, pos: [-20, 18, -84], look: [110, 38, -640], fov: 38 },
      { t: 1, pos: [-42, 66, -150], look: [110, 46, -640], fov: 36 },
    ],
    caption: { eyebrow: 'House of the foundation of heaven and earth', title: 'Etemenanki', sub: 'The great ziggurat of Marduk, about 91 metres high' },
  },
  {
    id: 'orbit', dur: 14, time: 'golden', proc: 40, warm: 2, ease: 'inout',
    orbit: { center: [0, 9, -20], radius: 86, height: 46, a0: 255, a1: 405, look: [0, 9, -20] },
    caption: { eyebrow: 'Front gate, light-well and main gate', title: 'The Double Gate', sub: 'Seen from the air' },
  },
  {
    id: 'morning', dur: 6, time: 'morning', proc: 30, warm: 3, ease: 'linear',
    keys: [
      { t: 0, pos: [-1.4, 2.0, 98], look: [0, 9.5, 0], fov: 42 },
      { t: 1, pos: [-1.3, 1.95, 93], look: [0, 9.5, 0], fov: 42 },
    ],
    caption: { eyebrow: '', title: 'Morning', sub: '' },
  },
  {
    id: 'midday', dur: 6, time: 'midday', proc: 26, warm: 3, ease: 'linear',
    keys: [
      { t: 0, pos: [-1.3, 1.95, 93], look: [0, 9.5, 0], fov: 42 },
      { t: 1, pos: [-1.2, 1.9, 88], look: [0, 9.5, 0], fov: 42 },
    ],
    caption: { eyebrow: '', title: 'Midday', sub: '' },
  },
  {
    id: 'night', dur: 8, time: 'night', proc: 22, warm: 4, ease: 'linear',
    keys: [
      { t: 0, pos: [-1.2, 1.9, 88], look: [0, 9.0, 0], fov: 42 },
      { t: 1, pos: [-1.1, 1.85, 81], look: [0, 9.0, 0], fov: 42 },
    ],
    caption: { eyebrow: '', title: 'Night', sub: 'Oil lamps and braziers light the way' },
  },
  {
    id: 'nightgate', dur: 9, time: 'night', proc: 150, warm: 4, ease: 'inout',
    keys: [
      { t: 0, pos: [7, 1.8, 19], look: [0, 5.5, 0], fov: 46 },
      { t: 1, pos: [2.5, 1.75, 11], look: [0, 6.5, 0], fov: 46 },
    ],
  },
  {
    id: 'end', dur: 9, time: 'golden', proc: 120, warm: 2, ease: 'inout',
    keys: [
      { t: 0, pos: [-60, 48, 196], look: [0, 10, 10], fov: 40 },
      { t: 1, pos: [-80, 58, 230], look: [0, 10, 10], fov: 40 },
    ],
    overlay: 'end',
  },
];

module.exports = { shots, OVERLAP, FPS: 30 };
