// /api/room — the authoritative game server.
//   GET  /api/room?code=ABCDE&v=12     poll (header x-player-token identifies your seat)
//   POST /api/room  { action, code, ... }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WP = require('../lib/engine');
const store = require('../lib/store');

let DICT = null;
function dictionary() {
  if (DICT) return DICT;
  const candidates = [path.join(process.cwd(), 'words.txt'), path.join(__dirname, '..', 'words.txt')];
  for (const file of candidates) {
    if (fs.existsSync(file)) { DICT = WP.buildDictionary(fs.readFileSync(file, 'utf8')); return DICT; }
  }
  throw new Error('words.txt not found next to the project root.');
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let s = '';
  const bytes = crypto.randomBytes(5);
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 20);

function seatFor(room, token) {
  if (!token) return null;
  for (const pid of WP.PLAYER_IDS) if (room.tokens && room.tokens[pid] === token) return pid;
  return null;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function view(room, token, extra = {}) {
  const pid = seatFor(room, token);
  return { ok: true, serverNow: Date.now(), seat: pid, state: WP.publicState(room, pid), ...extra };
}

const sanitizePlacements = (list) =>
  (Array.isArray(list) ? list : []).slice(0, 26).map((p) => ({
    tileId: String(p.tileId || ''), key: String(p.key || '').toUpperCase(),
    ...(p.letter ? { letter: String(p.letter).toUpperCase().slice(0, 1) } : {}),
  }));

const COMMANDS = {
  start: () => ({ type: 'START_GAME' }),
  submit_opening: (b) => ({ type: 'SUBMIT_OPENING_WORD', placements: sanitizePlacements(b.placements) }),
  place: (b) => ({ type: 'PLACE_WORD', placements: sanitizePlacements(b.placements) }),
  exchange_random: (b) => ({ type: 'EXCHANGE_RANDOM', tileIds: (b.tileIds || []).map(String) }),
  exchange_specific: (b) => ({ type: 'EXCHANGE_SPECIFIC', tileIds: (b.tileIds || []).map(String), desiredLetter: b.desiredLetter }),
  delete: (b) => ({ type: 'DELETE_WORD', wordId: String(b.wordId || '') }),
  pass: () => ({ type: 'PASS_TURN' }),
};

module.exports = async function handler(req, res) {
  try {
    if (process.env.VERCEL && !store.usingRedis) {
      return send(res, 500, { ok: false, error: 'Redis is not connected. Add Upstash Redis to this Vercel project, then redeploy (see README step 4).' });
    }
    const dict = dictionary();
    const now = Date.now();
    const token = String(req.headers['x-player-token'] || '').slice(0, 64);

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const code = cleanCode(url.searchParams.get('code'));
      const since = Number(url.searchParams.get('v') || 0);
      let room = await store.loadRoom(code);
      if (!room) return send(res, 404, { ok: false, error: `No game found with code ${code}.` });
      // Deadlines are enforced lazily: whoever polls after a deadline triggers the transition.
      const due = (room.status === 'opening' && now >= room.openingDeadline) ||
        (room.status === 'turn' && room.turnDeadline && now >= room.turnDeadline);
      if (due) {
        room = await store.withRoomLock(code, async () => {
          const fresh = await store.loadRoom(code);
          if (WP.tick(fresh, dict, Date.now())) { fresh.version++; fresh.updatedAt = Date.now(); await store.saveRoom(fresh); }
          return fresh;
        });
      }
      if (since && since === room.version) return send(res, 200, { ok: true, unchanged: true, serverNow: Date.now(), seat: seatFor(room, token) });
      return send(res, 200, view(room, token));
    }

    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed.' });
    const body = await readBody(req);
    const action = String(body.action || '');

    if (action === 'create') {
      if (!token) return send(res, 400, { ok: false, error: 'Missing player token.' });
      let code = newCode();
      for (let i = 0; i < 5 && (await store.roomExists(code)); i++) code = newCode();
      const room = WP.createRoom({ code, seed: crypto.randomBytes(8).toString('hex'), now });
      room.tokens = { p1: token };
      WP.addPlayer(room, 'p1', cleanName(body.name) || 'Player 1');
      await store.saveRoom(room);
      return send(res, 200, view(room, token));
    }

    const code = cleanCode(body.code);
    if (!code) return send(res, 400, { ok: false, error: 'Enter a game code.' });

    if (action === 'join') {
      const result = await store.withRoomLock(code, async () => {
        const room = await store.loadRoom(code);
        if (!room) return { status: 404, body: { ok: false, error: `No game found with code ${code}.` } };
        let pid = seatFor(room, token);
        if (!pid && token && !room.players.p2) {
          room.tokens.p2 = token;
          WP.addPlayer(room, 'p2', cleanName(body.name) || 'Player 2');
          room.version++; room.updatedAt = now;
          await store.saveRoom(room);
          pid = 'p2';
        } else if (pid && cleanName(body.name) && room.status === 'lobby') {
          room.players[pid].name = cleanName(body.name);
          room.version++;
          await store.saveRoom(room);
        }
        return { status: 200, body: view(room, token, pid ? {} : { spectator: true }) };
      });
      return send(res, result.status, result.body);
    }

    const build = COMMANDS[action];
    if (!build) return send(res, 400, { ok: false, error: 'Unknown action.' });
    const result = await store.withRoomLock(code, async () => {
      const room = await store.loadRoom(code);
      if (!room) return { status: 404, body: { ok: false, error: `No game found with code ${code}.` } };
      const pid = seatFor(room, token);
      if (!pid) return { status: 403, body: { ok: false, error: 'You are watching this game, not playing in it.' } };
      try {
        WP.applyCommand(room, pid, build(body), dict, Date.now());
      } catch (err) {
        if (err instanceof WP.GameError) {
          // A tick may still have advanced the room; persist that, then report the rule error.
          await store.saveRoom(room);
          return { status: 200, body: { ...view(room, token), ok: false, error: err.message } };
        }
        throw err;
      }
      await store.saveRoom(room);
      return { status: 200, body: view(room, token) };
    });
    return send(res, result.status, result.body);
  } catch (err) {
    console.error(err);
    return send(res, 500, { ok: false, error: err.message || 'Server error.' });
  }
};
