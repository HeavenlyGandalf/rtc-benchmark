#!/usr/bin/env node
// Агент эмуляции сети в контейнере-маршрутизаторе (compose-router.yml).
// Оркестратор в контейнере клиента не может вызвать tc на маршрутизаторе,
// поэтому маршрутизатор принимает команды по HTTP:
//   POST /apply/<profile>  — netem на всех интерфейсах, кроме lo
//   POST /clear            — снять ограничения
//   GET  /health           — готовность
// Порт — NETEM_AGENT_PORT (9000). Слушает только внутреннюю сеть стенда.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NETEM_AGENT_PORT ?? 9000);

function netem(args) {
  return execFileSync(process.execPath, [join(HERE, 'netem.mjs'), ...args], {
    env: { ...process.env, IFACE: 'auto' },
    encoding: 'utf8',
  });
}

createServer((req, res) => {
  const reply = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = req.url.match(/^\/apply\/([\w-]+)$/);
    if (req.method === 'POST' && m) return reply(200, { ok: true, log: netem(['apply', m[1]]) });
    if (req.method === 'POST' && req.url === '/clear') return reply(200, { ok: true, log: netem(['clear']) });
    if (req.url === '/health') return reply(200, { ok: true });
    reply(404, { error: 'not found' });
  } catch (err) {
    reply(500, { error: String(err.stderr ?? err) });
  }
}).listen(PORT, () => console.log(`[netem-agent] :${PORT}`));
