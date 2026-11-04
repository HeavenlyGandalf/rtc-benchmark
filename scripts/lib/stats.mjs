// Статистика для анализа по прогонам (единица анализа — прогон, не сообщение).
// Без внешних зависимостей, чтобы анализ шёл в том же образе с теми же версиями.
import { mulberry32 } from './rng.mjs';

export const median = (xs) => quantile(xs, 0.5);

/** Квантиль с линейной интерполяцией (тип 7, как в R и numpy по умолчанию). */
export function quantile(xs, q) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]) - s[lo]);
}

function resample(xs, rand) {
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rand() * xs.length)];
  return out;
}

/** Перцентильный бутстреп-ДИ медианы. */
export function bootstrapMedianCi(xs, { iters = 10_000, level = 0.95, seed = 20261103 } = {}) {
  const v = xs.filter(Number.isFinite);
  if (v.length < 2) return [NaN, NaN];
  const rand = mulberry32(seed);
  const meds = Array.from({ length: iters }, () => median(resample(v, rand)));
  return [quantile(meds, (1 - level) / 2), quantile(meds, 1 - (1 - level) / 2)];
}

/** Отношение медиан a/b и его перцентильный бутстреп-ДИ (выборки перевыбираются независимо). */
export function ratioOfMedians(a, b, { iters = 10_000, level = 0.95, seed = 20261103 } = {}) {
  const va = a.filter(Number.isFinite);
  const vb = b.filter(Number.isFinite);
  const ratio = median(va) / median(vb);
  if (va.length < 2 || vb.length < 2) return { ratio, ci: [NaN, NaN] };
  const rand = mulberry32(seed);
  const rs = Array.from({ length: iters }, () => median(resample(va, rand)) / median(resample(vb, rand)));
  return { ratio, ci: [quantile(rs, (1 - level) / 2), quantile(rs, 1 - (1 - level) / 2)] };
}

// Нормальная функция распределения (Abramowitz–Stegun 7.1.26, погрешность < 1.5e-7).
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * Критерий Манна–Уитни: нормальное приближение с поправкой на связи и
 * на непрерывность. alternative: 'two-sided' | 'less' (a < b) | 'greater' (a > b).
 */
export function mannWhitney(a, b, alternative = 'two-sided') {
  const va = a.filter(Number.isFinite);
  const vb = b.filter(Number.isFinite);
  const n1 = va.length;
  const n2 = vb.length;
  if (!n1 || !n2) return { U: NaN, p: NaN };
  const all = [...va.map((v) => [v, 0]), ...vb.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  const r1 = all.reduce((s, [, g], i) => (g === 0 ? s + ranks[i] : s), 0);
  const U1 = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return { U: U1, p: 1 };
  const z = (dir) => (U1 - mu - dir * 0.5) / sigma;
  let p;
  if (alternative === 'less') p = normCdf(z(-1));
  else if (alternative === 'greater') p = 1 - normCdf(z(1));
  else p = Math.min(1, 2 * Math.min(normCdf(z(-1)), 1 - normCdf(z(1))));
  return { U: U1, p };
}

/** δ Клиффа: P(a > b) − P(a < b); |δ| < 0,147 пренебрежимо, < 0,33 мало, < 0,474 средне. */
export function cliffsDelta(a, b) {
  let gt = 0;
  let lt = 0;
  for (const x of a) for (const y of b) {
    if (x > y) gt++;
    else if (x < y) lt++;
  }
  return (gt - lt) / (a.length * b.length || 1);
}

/**
 * Поправка Холма–Бонферрони: возвращает скорректированные p в исходном порядке.
 * Нечисловые p (нет данных по профилю) в семейство не входят и остаются NaN —
 * иначе NaN ломал бы сортировку и обнулял решения по остальным профилям.
 */
export function holm(ps) {
  const out = ps.map(() => NaN);
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((x, y) => x[0] - y[0]);
  let running = 0;
  idx.forEach(([p, i], k) => {
    running = Math.max(running, Math.min(1, (idx.length - k) * p));
    out[i] = running;
  });
  return out;
}
