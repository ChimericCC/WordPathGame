// Room storage. Uses Upstash Redis over its REST API (no npm dependency).
// Accepts either the Upstash names or the KV_* names Vercel's marketplace integration injects.
// With no credentials it falls back to process memory — fine for `node dev-server.js`,
// NOT for Vercel (serverless instances don't share memory).

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 7;

const memory = globalThis.__WORDPATH_MEM__ || (globalThis.__WORDPATH_MEM__ = new Map());

async function redis(...args) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

const usingRedis = Boolean(URL_ && TOKEN);

async function get(key) {
  if (!usingRedis) { const v = memory.get(key); return v === undefined ? null : v; }
  return redis('GET', key);
}
async function set(key, value, { nx = false, px, ex } = {}) {
  if (!usingRedis) {
    const hit = memory.get(key);
    if (nx && hit !== undefined && !(hit && hit.__exp && hit.__exp < Date.now())) return null;
    memory.set(key, px ? { __exp: Date.now() + px, value } : value);
    return 'OK';
  }
  const args = ['SET', key, value];
  if (nx) args.push('NX');
  if (px) args.push('PX', String(px));
  if (ex) args.push('EX', String(ex));
  return redis(...args);
}
async function del(key) {
  if (!usingRedis) { memory.delete(key); return 1; }
  return redis('DEL', key);
}

const roomKey = (code) => `wordpath:room:${code}`;
const lockKey = (code) => `wordpath:lock:${code}`;

async function loadRoom(code) {
  const raw = await get(roomKey(code));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveRoom(room) {
  await set(roomKey(room.id), JSON.stringify(room), { ex: ROOM_TTL_SECONDS });
}
async function roomExists(code) { return Boolean(await get(roomKey(code))); }

// Serialise writes to one room: SET NX lock with a short expiry, retried briefly.
async function withRoomLock(code, fn) {
  const token = Math.random().toString(36).slice(2);
  for (let i = 0; i < 40; i++) {
    if (await set(lockKey(code), token, { nx: true, px: 4000 })) {
      try { return await fn(); } finally { await del(lockKey(code)); }
    }
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new Error('The room is busy. Try that again.');
}

module.exports = { loadRoom, saveRoom, roomExists, withRoomLock, usingRedis };
