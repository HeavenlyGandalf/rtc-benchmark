// Детерминированный ГСЧ для рандомизации порядка прогонов и бутстрепа.
// Mulberry32: 32-битное состояние, одинаковая последовательность при одном сиде
// на любой платформе — этого достаточно для перестановок и перевыборок.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Перестановка Фишера–Йетса (новый массив). */
export function shuffle(items, rand) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Сид прогона из сида плана и номера прогона (чтобы прогоны не делили поток). */
export function deriveSeed(base, index) {
  return (Math.imul(base >>> 0, 2654435761) + index * 0x9e3779b9) >>> 0;
}
