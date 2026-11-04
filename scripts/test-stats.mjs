// Модульные тесты статистики (scripts/lib/stats.mjs) на значениях, посчитанных вручную.
import assert from 'node:assert/strict';
import { median, quantile, mannWhitney, cliffsDelta, holm, ratioOfMedians, bootstrapMedianCi } from './lib/stats.mjs';

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

close(median([3, 1, 2]), 2);
close(median([1, 2, 3, 4]), 2.5);
close(quantile([1, 2, 3, 4, 5], 0.95), 4.8);

// U = 0, z = (0 − 12,5 + 0,5) / √(25·11/12) = −2,5067 → p₂ = 0,0122
const mw = mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
close(mw.U, 0);
close(mw.p, 0.0122, 5e-4);
close(mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 'less').p, 0.0061, 3e-4);
assert.ok(mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 'greater').p > 0.99);
close(mannWhitney([1, 1, 1], [1, 1, 1]).p, 1);

close(cliffsDelta([6, 7, 8], [1, 2, 3]), 1);
close(cliffsDelta([1, 2], [1, 2]), 0);

assert.deepEqual(holm([0.01, 0.04, 0.03]).map((p) => +p.toFixed(4)), [0.03, 0.06, 0.06]);
// NaN (нет данных по профилю) не портит поправку для остальных
const h = holm([0.01, NaN, 0.03]);
assert.ok(Number.isNaN(h[1]));
assert.deepEqual([h[0], h[2]].map((p) => +p.toFixed(4)), [0.02, 0.03]);

const { ratio, ci } = ratioOfMedians([10, 11, 12, 10, 11], [5, 5.5, 6, 5, 5.5]);
close(ratio, 2);
assert.ok(ci[0] <= 2 && ci[1] >= 2);
const [lo, hi] = bootstrapMedianCi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.ok(lo <= 5.5 && hi >= 5.5 && lo >= 1 && hi <= 10);
// одинаковый сид — одинаковый ДИ (воспроизводимость анализа)
assert.deepEqual(bootstrapMedianCi([1, 2, 3, 4, 5]), bootstrapMedianCi([1, 2, 3, 4, 5]));

console.log('stats: все проверки пройдены');
