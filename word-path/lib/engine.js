/* Word Path — authoritative game engine.
 * Pure logic, no I/O. Loaded by the API (CommonJS) and the browser (window.WP)
 * so the client can preview moves with exactly the server's rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- config
  const CONFIG = {
    BOARD_SIZE: 26,
    OPENING_MS: 35000,
    TURN_MS: 35000,
    STARTING_CAPACITY: 18,
    MAX_CAPACITY: 24,
    MIN_CAPACITY: 4,
    RANDOM_EXCHANGE_COST: 2,
    RANDOM_EXCHANGE_GAIN: 1,
    RANDOM_EXCHANGE_CAPACITY_LOSS: 1,
    SPECIFIC_EXCHANGE_COST: 3,
    SPECIFIC_EXCHANGE_GAIN: 1,
    SPECIFIC_EXCHANGE_CAPACITY_LOSS: 2,
    EXCHANGE_ENDS_TURN: true, // brief: a turn is ONE of play / exchange / delete / pass
    DELETE_ENDS_TURN: true,
    INVENTORY_SQUARES: 10,
    WILD_SQUARES: 10,
    GUARANTEED_WORD_LENGTHS: [8, 6],
    MAX_IDLE_TURNS: 8, // consecutive passes/timeouts before the game ends in a draw
  };

  const ROWS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const PLAYER_IDS = ['p1', 'p2'];
  const PLAYERS = {
    p1: { color: 'blue', start: 'A5', end: 'Z22' },
    p2: { color: 'magenta', start: 'A22', end: 'Z5' },
  };

  // Approximate English letter frequency (per 1000)
  const LETTER_WEIGHTS = {
    A: 82, B: 15, C: 28, D: 43, E: 127, F: 22, G: 20, H: 61, I: 70, J: 2, K: 8, L: 40, M: 24,
    N: 67, O: 75, P: 19, Q: 1, R: 60, S: 63, T: 91, U: 28, V: 10, W: 24, X: 2, Y: 20, Z: 1,
  };

  // ----------------------------------------------------------- coordinates
  function coordKey(c) { return `${c.row}${c.col}`; }
  function parseKey(key) {
    const m = /^([A-Z])(\d{1,2})$/.exec(String(key));
    if (!m) return null;
    const col = Number(m[2]);
    if (col < 1 || col > CONFIG.BOARD_SIZE || ROWS.indexOf(m[1]) >= CONFIG.BOARD_SIZE) return null;
    return { row: m[1], col };
  }
  // numeric helpers: r = 0 for row A (bottom), c = 0 for column 1 (left)
  function rc(key) { const p = parseKey(key); return p ? { r: ROWS.indexOf(p.row), c: p.col - 1 } : null; }
  function keyOf(r, c) {
    if (r < 0 || c < 0 || r >= CONFIG.BOARD_SIZE || c >= CONFIG.BOARD_SIZE) return null;
    return ROWS[r] + (c + 1);
  }
  // Horizontal words read left→right (col +1). Vertical words read A→Z (row +1, i.e. upward).
  const DIRS = { horizontal: { dr: 0, dc: 1 }, vertical: { dr: 1, dc: 0 } };
  function neighbors(key) {
    const p = rc(key);
    return [keyOf(p.r + 1, p.c), keyOf(p.r - 1, p.c), keyOf(p.r, p.c + 1), keyOf(p.r, p.c - 1)].filter(Boolean);
  }

  // ------------------------------------------------------------- seeded rng
  function hashString(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Every random draw advances room.rngCount, so a room is replayable from its seed + command log.
  function roomRandom(room) {
    room.rngCount = (room.rngCount || 0) + 1;
    return mulberry32(hashString(`${room.seed}:${room.rngCount}`))();
  }
  function randInt(room, n) { return Math.floor(roomRandom(room) * n); }
  function shuffle(room, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(room, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  const WEIGHT_TOTAL = Object.values(LETTER_WEIGHTS).reduce((a, b) => a + b, 0);
  function randomLetter(room) {
    let x = roomRandom(room) * WEIGHT_TOTAL;
    for (const [l, w] of Object.entries(LETTER_WEIGHTS)) { if ((x -= w) < 0) return l; }
    return 'E';
  }

  // -------------------------------------------------------------- dictionary
  function buildDictionary(text) {
    const words = new Set();
    const byLength = {};
    for (const raw of String(text).split(/\r?\n/)) {
      const w = raw.trim().toUpperCase();
      if (!/^[A-Z]{2,}$/.test(w)) continue;
      words.add(w);
      (byLength[w.length] = byLength[w.length] || []).push(w);
    }
    return { has: (w) => words.has(String(w).toUpperCase()), byLength, size: words.size };
  }

  // ------------------------------------------------------------------- rack
  function newTile(room, letter, isWild) {
    room.tileCount = (room.tileCount || 0) + 1;
    const t = { id: `t${room.tileCount}`, letter };
    if (isWild) t.isWild = true;
    return t;
  }
  function generateRack(room, dict) {
    const letters = [];
    for (const len of CONFIG.GUARANTEED_WORD_LENGTHS) {
      const pool = (dict.byLength[len] || []).filter((w) => !/[QXZJ]/.test(w));
      if (pool.length) letters.push(...pool[randInt(room, pool.length)].split(''));
    }
    while (letters.length < CONFIG.STARTING_CAPACITY) letters.push(randomLetter(room));
    letters.length = CONFIG.STARTING_CAPACITY;
    return shuffle(room, letters).map((l) => newTile(room, l));
  }
  function letterTiles(rack) { return rack.filter((t) => !t.isWild); }
  function refillRack(room, player) {
    while (letterTiles(player.rack).length < player.capacity) player.rack.push(newTile(room, randomLetter(room)));
  }
  // Can these tiles (wilds count as any letter) spell `word`? Used by tests and rack guarantees.
  function canSpell(rack, word) {
    const counts = {};
    let wild = 0;
    for (const t of rack) { if (t.isWild) wild++; else counts[t.letter] = (counts[t.letter] || 0) + 1; }
    for (const ch of word) { if (counts[ch]) counts[ch]--; else if (wild) wild--; else return false; }
    return true;
  }

  // ---------------------------------------------------------------- specials
  function generateSpecials(room) {
    const blocked = new Set();
    for (const pid of PLAYER_IDS) for (const k of [PLAYERS[pid].start, PLAYERS[pid].end]) {
      blocked.add(k); neighbors(k).forEach((n) => blocked.add(n));
    }
    const specials = {};
    const place = (type, count) => {
      let guard = 0;
      while (count > 0 && guard++ < 5000) {
        const k = keyOf(randInt(room, CONFIG.BOARD_SIZE), randInt(room, CONFIG.BOARD_SIZE));
        if (blocked.has(k) || specials[k]) continue;
        specials[k] = { type, consumedBy: null };
        count--;
      }
    };
    place('inventory_plus', CONFIG.INVENTORY_SQUARES);
    place('wild_star', CONFIG.WILD_SQUARES);
    return specials;
  }

  // ------------------------------------------------------------------- rooms
  function createRoom({ code, seed, now }) {
    return {
      id: code, seed, status: 'lobby', version: 1, round: 0,
      rngCount: 0, tileCount: 0, wordCount: 0,
      players: {}, board: {}, words: {}, specials: {},
      currentTurnPlayerId: null, turnDeadline: null, openingDeadline: null,
      openingSubmissions: {}, winnerId: null, winningPathCoords: null, endReason: null,
      idleTurns: 0, log: [], lastMove: null, createdAt: now, updatedAt: now,
    };
  }
  function addPlayer(room, pid, name) {
    const def = PLAYERS[pid];
    room.players[pid] = {
      id: pid, name: String(name || (pid === 'p1' ? 'Player 1' : 'Player 2')).slice(0, 20),
      color: def.color, startCoord: def.start, endCoord: def.end,
      rack: [], capacity: CONFIG.STARTING_CAPACITY, wildTokens: 0,
      firstWordId: null, connectedToEnd: false,
    };
  }
  function other(pid) { return pid === 'p1' ? 'p2' : 'p1'; }
  function pushLog(room, text) { room.log.push({ t: Date.now(), text }); if (room.log.length > 40) room.log.shift(); }

  function startGame(room, dict, now) {
    if (!room.players.p1 || !room.players.p2) throw new GameError('Waiting for a second player to join.');
    room.round = (room.round || 0) + 1;
    if (room.round > 1) room.seed = `${room.seed.split('#')[0]}#${room.round}`;
    room.rngCount = 0; room.tileCount = 0; room.wordCount = 0;
    room.board = {}; room.words = {}; room.specials = generateSpecials(room);
    for (const pid of PLAYER_IDS) {
      const p = room.players[pid];
      Object.assign(p, { capacity: CONFIG.STARTING_CAPACITY, wildTokens: 0, firstWordId: null, connectedToEnd: false });
      p.rack = generateRack(room, dict);
    }
    room.status = 'opening';
    room.openingDeadline = now + CONFIG.OPENING_MS;
    room.openingSubmissions = {};
    room.currentTurnPlayerId = null; room.turnDeadline = null;
    room.winnerId = null; room.winningPathCoords = null; room.endReason = null;
    room.idleTurns = 0; room.lastMove = null; room.log = [];
    pushLog(room, 'Opening phase: build your longest word through your start square.');
  }

  class GameError extends Error {}

  // --------------------------------------------------------------- placement
  // placements: [{ tileId, key, letter? }] — `letter` is required for wild tiles.
  // Returns { ok, error?, words: [{text, keys, orientation}], placed: [{key, letter, tileId}] }
  function validatePlacement(room, pid, placements, dict, opts = {}) {
    const fail = (error) => ({ ok: false, error, words: [] });
    const player = room.players[pid];
    const board = opts.board || room.board;
    if (!player) return fail('You are not seated in this game.');
    if (!Array.isArray(placements) || placements.length === 0) return fail('Place at least one tile.');

    const seenKeys = new Set();
    const seenTiles = new Set();
    const placed = [];
    for (const p of placements) {
      if (!p || !parseKey(p.key)) return fail('That square is off the board.');
      if (seenKeys.has(p.key)) return fail('Two tiles are on the same square.');
      if (seenTiles.has(p.tileId)) return fail('A rack tile was used twice.');
      if (board[p.key]) return fail(`${p.key} is already taken.`);
      const tile = player.rack.find((t) => t.id === p.tileId);
      if (!tile) return fail('That tile is not in your rack.');
      let letter = tile.letter;
      if (tile.isWild) {
        letter = String(p.letter || '').toUpperCase();
        if (!/^[A-Z]$/.test(letter)) return fail('Choose a letter for your wild tile.');
      }
      seenKeys.add(p.key); seenTiles.add(p.tileId);
      placed.push({ key: p.key, letter, tileId: p.tileId, wild: !!tile.isWild });
    }

    const pts = placed.map((p) => rc(p.key));
    const sameRow = pts.every((p) => p.r === pts[0].r);
    const sameCol = pts.every((p) => p.c === pts[0].c);
    if (!sameRow && !sameCol) return fail('Words must run in one straight line.');

    const letterAt = (k) => {
      const np = placed.find((p) => p.key === k);
      if (np) return np.letter;
      return board[k] ? board[k].letter : null;
    };
    const runFrom = (key, dir) => {
      const d = DIRS[dir];
      let p = rc(key);
      while (letterAt(keyOf(p.r - d.dr, p.c - d.dc))) p = { r: p.r - d.dr, c: p.c - d.dc };
      const keys = [];
      for (let k = keyOf(p.r, p.c); k && letterAt(k); p = { r: p.r + d.dr, c: p.c + d.dc }, k = keyOf(p.r, p.c)) keys.push(k);
      return keys;
    };

    let orientation;
    if (placed.length > 1) orientation = sameRow ? 'horizontal' : 'vertical';
    else {
      const h = runFrom(placed[0].key, 'horizontal').length;
      const v = runFrom(placed[0].key, 'vertical').length;
      if (h < 2 && v < 2) return fail('A word needs at least two letters.');
      orientation = h >= v ? 'horizontal' : 'vertical';
    }
    const cross = orientation === 'horizontal' ? 'vertical' : 'horizontal';

    const main = runFrom(placed[0].key, orientation);
    if (!placed.every((p) => main.includes(p.key))) return fail('No gaps: tiles in a word must touch.');
    if (main.length < 2) return fail('A word needs at least two letters.');

    const words = [{ keys: main, orientation }];
    for (const p of placed) {
      const run = runFrom(p.key, cross);
      if (run.length >= 2) words.push({ keys: run, orientation: cross });
    }
    for (const w of words) w.text = w.keys.map(letterAt).join('');

    const bad = words.filter((w) => !dict.has(w.text));
    if (bad.length) return { ok: false, error: `Not in the dictionary: ${bad.map((w) => w.text).join(', ')}`, words, placed, badWords: bad.map((w) => w.text) };

    const placedKeys = new Set(placed.map((p) => p.key));
    if (!player.firstWordId) {
      if (!placedKeys.has(player.startCoord)) {
        return { ok: false, error: `Your first word must put its master letter on ${player.startCoord}.`, words, placed };
      }
    } else {
      const touchesNetwork = words.some((w) => w.keys.some((k) => !placedKeys.has(k) && board[k] && board[k].ownerIds.includes(pid)));
      if (!touchesNetwork) return { ok: false, error: 'New words must connect to your existing tiles.', words, placed };
    }
    return { ok: true, words, placed, orientation };
  }

  function recomputeOwners(room, key) {
    const cell = room.board[key];
    if (!cell) return;
    cell.ownerIds = [...new Set(cell.wordIds.map((id) => room.words[id] && room.words[id].playerId).filter(Boolean))].sort();
  }

  function applyPlacement(room, pid, result, now, { isFirstWord = false } = {}) {
    const player = room.players[pid];
    const placedKeys = new Set(result.placed.map((p) => p.key));
    for (const p of result.placed) {
      room.board[p.key] = { letter: p.letter, ownerIds: [], wordIds: [], wild: p.wild || undefined, placedBy: pid };
    }
    const newWordIds = [];
    result.words.forEach((w, i) => {
      const id = `w${++room.wordCount}`;
      const locked = isFirstWord && i === 0;
      room.words[id] = { id, playerId: pid, text: w.text, coords: w.keys, orientation: w.orientation, lockedFirstWord: locked, createdAt: now };
      if (locked) player.firstWordId = id;
      for (const k of w.keys) { room.board[k].wordIds.push(id); }
      newWordIds.push(id);
    });
    for (const w of result.words) for (const k of w.keys) recomputeOwners(room, k);

    // Specials are consumed by newly placed tiles that land on them.
    const gains = [];
    for (const k of placedKeys) {
      const s = room.specials[k];
      if (!s || s.consumedBy) continue;
      s.consumedBy = pid;
      if (s.type === 'inventory_plus') {
        if (player.capacity < CONFIG.MAX_CAPACITY) { player.capacity++; gains.push('+1 inventory space'); }
      } else if (s.type === 'wild_star') {
        player.rack.push(newTile(room, '*', true));
        gains.push('a wild tile');
      }
    }
    const usedTiles = new Set(result.placed.map((p) => p.tileId));
    player.rack = player.rack.filter((t) => !usedTiles.has(t.id));
    refillRack(room, player);
    player.wildTokens = player.rack.filter((t) => t.isWild).length;
    room.lastMove = { playerId: pid, wordIds: newWordIds, keys: [...placedKeys], at: now };
    return gains;
  }

  // ------------------------------------------------------------------- paths
  function findPath(room, pid) {
    const p = room.players[pid];
    if (!p) return null;
    const owned = (k) => room.board[k] && room.board[k].ownerIds.includes(pid);
    if (!owned(p.startCoord)) return null;
    const prev = { [p.startCoord]: null };
    const queue = [p.startCoord];
    while (queue.length) {
      const k = queue.shift();
      if (k === p.endCoord) {
        const path = [];
        for (let c = k; c; c = prev[c]) path.unshift(c);
        return path;
      }
      for (const n of neighbors(k)) if (!(n in prev) && owned(n)) { prev[n] = k; queue.push(n); }
    }
    return null;
  }
  // Furthest progress toward the end row, for the HUD.
  function networkReach(room, pid) {
    const p = room.players[pid];
    const owned = (k) => room.board[k] && room.board[k].ownerIds.includes(pid);
    if (!owned(p.startCoord)) return { anchored: false, size: 0, bestRow: null };
    const seen = new Set([p.startCoord]);
    const queue = [p.startCoord];
    let best = 0;
    while (queue.length) {
      const k = queue.shift();
      best = Math.max(best, rc(k).r);
      for (const n of neighbors(k)) if (!seen.has(n) && owned(n)) { seen.add(n); queue.push(n); }
    }
    return { anchored: true, size: seen.size, bestRow: ROWS[best] };
  }
  function checkWin(room, pid, now) {
    const path = findPath(room, pid);
    room.players[pid].connectedToEnd = !!path;
    if (path) {
      room.status = 'finished';
      room.winnerId = pid;
      room.winningPathCoords = path;
      room.endReason = 'path';
      room.turnDeadline = null;
      pushLog(room, `${room.players[pid].name} connected ${room.players[pid].startCoord} to ${room.players[pid].endCoord}!`);
    }
    return !!path;
  }

  // ------------------------------------------------------------------ turns
  function beginTurn(room, pid, now) {
    room.status = 'turn';
    room.currentTurnPlayerId = pid;
    room.turnDeadline = now + CONFIG.TURN_MS;
  }
  function endTurn(room, now, { idle = false } = {}) {
    room.idleTurns = idle ? room.idleTurns + 1 : 0;
    if (room.idleTurns >= CONFIG.MAX_IDLE_TURNS) {
      room.status = 'finished'; room.winnerId = null; room.endReason = 'idle'; room.turnDeadline = null;
      pushLog(room, 'Too many passes in a row — the game ends in a draw.');
      return;
    }
    beginTurn(room, other(room.currentTurnPlayerId), now);
  }

  function resolveOpening(room, dict, now) {
    const subs = PLAYER_IDS
      .map((pid) => ({ pid, sub: room.openingSubmissions[pid] }))
      .filter((s) => s.sub && s.sub.valid);
    // Longest first; equal lengths ordered by the room seed.
    const tieFirst = randInt(room, 2) === 0 ? 'p1' : 'p2';
    subs.sort((a, b) => (b.sub.length - a.sub.length) || (a.pid === tieFirst ? -1 : 1));
    for (const { pid, sub } of subs) {
      // Re-check against the live board in case both opening words collide.
      const res = validatePlacement(room, pid, sub.placements, dict);
      if (res.ok) {
        applyPlacement(room, pid, res, now, { isFirstWord: true });
        pushLog(room, `${room.players[pid].name} opened with ${res.words[0].text} (${res.words[0].text.length}).`);
      } else {
        pushLog(room, `${room.players[pid].name}'s opening word collided and was not placed.`);
      }
    }
    for (const pid of PLAYER_IDS) if (!room.openingSubmissions[pid]) pushLog(room, `${room.players[pid].name} did not submit an opening word.`);
    const first = subs.length ? subs[0].pid : tieFirst;
    if (!subs.length) pushLog(room, 'No valid opening words — coin flip decides who starts.');
    room.openingDeadline = null;
    beginTurn(room, first, now);
    pushLog(room, `${room.players[first].name} takes the first turn.`);
  }

  // Lazily apply expired deadlines. Returns true if state changed.
  function tick(room, dict, now) {
    let changed = false;
    if (room.status === 'opening' && now >= room.openingDeadline) { resolveOpening(room, dict, now); changed = true; }
    if (room.status === 'turn' && room.turnDeadline && now >= room.turnDeadline) {
      pushLog(room, `${room.players[room.currentTurnPlayerId].name} ran out of time.`);
      endTurn(room, now, { idle: true });
      changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- commands
  function requireTurn(room, pid) {
    if (room.status !== 'turn') throw new GameError('The game is not in a playing turn.');
    if (room.currentTurnPlayerId !== pid) throw new GameError("It's not your turn.");
  }

  function applyCommand(room, pid, cmd, dict, now) {
    if (tick(room, dict, now)) room.version++; // keep clients in sync even if the command below is rejected
    const player = room.players[pid];
    switch (cmd.type) {
      case 'START_GAME': {
        if (!player) throw new GameError('Only seated players can start the game.');
        if (room.status !== 'lobby' && room.status !== 'finished') throw new GameError('The game is already running.');
        startGame(room, dict, now);
        break;
      }
      case 'SUBMIT_OPENING_WORD': {
        if (room.status !== 'opening') throw new GameError('The opening phase is over.');
        if (room.openingSubmissions[pid]) throw new GameError('You already submitted your opening word.');
        const res = validatePlacement(room, pid, cmd.placements, dict, { board: {} });
        if (!res.ok) throw new GameError(res.error);
        room.openingSubmissions[pid] = { placements: cmd.placements, valid: true, length: res.words[0].text.length, text: res.words[0].text, at: now };
        pushLog(room, `${player.name} locked in an opening word.`);
        if (PLAYER_IDS.every((p) => room.openingSubmissions[p])) resolveOpening(room, dict, now);
        break;
      }
      case 'PLACE_WORD': {
        requireTurn(room, pid);
        const res = validatePlacement(room, pid, cmd.placements, dict);
        if (!res.ok) throw new GameError(res.error);
        const first = !player.firstWordId;
        const gains = applyPlacement(room, pid, res, now, { isFirstWord: first });
        pushLog(room, `${player.name} played ${res.words.map((w) => w.text).join(' + ')}${gains.length ? ` and gained ${gains.join(' and ')}` : ''}.`);
        if (!checkWin(room, pid, now)) endTurn(room, now);
        break;
      }
      case 'EXCHANGE_RANDOM':
      case 'EXCHANGE_SPECIFIC': {
        requireTurn(room, pid);
        const specific = cmd.type === 'EXCHANGE_SPECIFIC';
        const cost = specific ? CONFIG.SPECIFIC_EXCHANGE_COST : CONFIG.RANDOM_EXCHANGE_COST;
        const gain = specific ? CONFIG.SPECIFIC_EXCHANGE_GAIN : CONFIG.RANDOM_EXCHANGE_GAIN;
        const loss = specific ? CONFIG.SPECIFIC_EXCHANGE_CAPACITY_LOSS : CONFIG.RANDOM_EXCHANGE_CAPACITY_LOSS;
        const ids = [...new Set(cmd.tileIds || [])];
        if (ids.length !== cost) throw new GameError(`Select exactly ${cost} tiles to exchange.`);
        const tiles = ids.map((id) => player.rack.find((t) => t.id === id));
        if (tiles.some((t) => !t)) throw new GameError('Those tiles are not in your rack.');
        if (tiles.some((t) => t.isWild)) throw new GameError('Wild tiles cannot be exchanged.');
        if (player.capacity - loss < CONFIG.MIN_CAPACITY) throw new GameError(`Your inventory cannot drop below ${CONFIG.MIN_CAPACITY} spaces.`);
        let desired = null;
        if (specific) {
          desired = String(cmd.desiredLetter || '').toUpperCase();
          if (!/^[A-Z]$/.test(desired)) throw new GameError('Choose the letter you want.');
        }
        player.rack = player.rack.filter((t) => !ids.includes(t.id));
        for (let i = 0; i < gain; i++) player.rack.push(newTile(room, desired || randomLetter(room)));
        player.capacity -= loss;
        pushLog(room, `${player.name} exchanged ${cost} tiles for ${specific ? `a ${desired}` : 'a random tile'} (capacity ${player.capacity}).`);
        if (CONFIG.EXCHANGE_ENDS_TURN) endTurn(room, now);
        break;
      }
      case 'DELETE_WORD': {
        requireTurn(room, pid);
        const word = room.words[cmd.wordId];
        if (!word) throw new GameError('That word is no longer on the board.');
        if (word.playerId !== pid) throw new GameError('You can only delete your own words.');
        if (word.lockedFirstWord) throw new GameError('Your first word is locked and cannot be deleted.');
        delete room.words[word.id];
        const removed = [];
        for (const k of word.coords) {
          const cell = room.board[k];
          if (!cell) continue;
          cell.wordIds = cell.wordIds.filter((id) => id !== word.id);
          if (!cell.wordIds.length) { delete room.board[k]; removed.push(k); } else recomputeOwners(room, k);
        }
        for (const p of PLAYER_IDS) if (room.players[p]) room.players[p].connectedToEnd = !!findPath(room, p);
        room.lastMove = { playerId: pid, deleted: word.text, keys: removed, at: now };
        pushLog(room, `${player.name} deleted ${word.text}.`);
        if (CONFIG.DELETE_ENDS_TURN) endTurn(room, now);
        break;
      }
      case 'PASS_TURN': {
        requireTurn(room, pid);
        pushLog(room, `${player.name} passed.`);
        endTurn(room, now, { idle: true });
        break;
      }
      default:
        throw new GameError('Unknown command.');
    }
    room.version++;
    room.updatedAt = now;
    return room;
  }

  // What everyone may see. Racks and unrevealed opening words stay private.
  function publicState(room, viewerPid) {
    const players = {};
    for (const [pid, p] of Object.entries(room.players)) {
      const reach = room.status === 'lobby' ? { anchored: false, size: 0, bestRow: null } : networkReach(room, pid);
      players[pid] = {
        id: pid, name: p.name, color: p.color, startCoord: p.startCoord, endCoord: p.endCoord,
        capacity: p.capacity, wildTokens: p.wildTokens, rackCount: p.rack.length,
        firstWordId: p.firstWordId, connectedToEnd: p.connectedToEnd, reach,
        openingSubmitted: !!room.openingSubmissions[pid],
      };
    }
    const me = viewerPid && room.players[viewerPid]
      ? { id: viewerPid, rack: room.players[viewerPid].rack, openingSubmission: room.openingSubmissions[viewerPid] || null }
      : null;
    return {
      id: room.id, status: room.status, version: room.version, round: room.round,
      players, board: room.board, words: room.words, specials: room.specials,
      currentTurnPlayerId: room.currentTurnPlayerId, turnDeadline: room.turnDeadline,
      openingDeadline: room.openingDeadline, winnerId: room.winnerId,
      winningPathCoords: room.winningPathCoords, endReason: room.endReason,
      lastMove: room.lastMove, log: room.log, me,
    };
  }

  // ------------------------------------------------------------- demo board
  // A fixed board proving the path logic: Player 1 wins A5 → Z22, Player 2 is mid-route.
  function buildDemoRoom() {
    const room = createRoom({ code: 'DEMO', seed: 'demo', now: 0 });
    addPlayer(room, 'p1', 'Player 1');
    addPlayer(room, 'p2', 'Player 2');
    room.specials = {
      G20: { type: 'inventory_plus', consumedBy: null }, M8: { type: 'wild_star', consumedBy: null },
      J18: { type: 'inventory_plus', consumedBy: null }, R6: { type: 'wild_star', consumedBy: null },
      U12: { type: 'wild_star', consumedBy: null }, E16: { type: 'inventory_plus', consumedBy: null },
      W3: { type: 'inventory_plus', consumedBy: null }, P24: { type: 'wild_star', consumedBy: null },
    };
    const spec = {
      p1: [['TREE', 'A5', 'vertical'], ['EARTH', 'D5', 'horizontal'], ['HILL', 'D9', 'vertical'], ['LAKE', 'G9', 'horizontal'],
        ['EAGLE', 'G12', 'vertical'], ['ECHO', 'K12', 'horizontal'], ['OCEAN', 'K15', 'vertical'], ['NORTH', 'O15', 'horizontal'],
        ['HAVEN', 'O19', 'vertical'], ['NOVA', 'S19', 'horizontal'], ['ASCEND', 'S22', 'vertical'], ['DAY', 'X22', 'vertical']],
      p2: [['FIRE', 'A22', 'vertical'], ['EAST', 'D22', 'horizontal'], ['TIDE', 'D25', 'vertical']],
    };
    for (const pid of PLAYER_IDS) {
      spec[pid].forEach(([text, start, orientation], i) => {
        const d = DIRS[orientation];
        const s = rc(start);
        const keys = text.split('').map((_, j) => keyOf(s.r + d.dr * j, s.c + d.dc * j));
        const id = `w${++room.wordCount}`;
        room.words[id] = { id, playerId: pid, text, coords: keys, orientation, lockedFirstWord: i === 0, createdAt: i };
        if (i === 0) room.players[pid].firstWordId = id;
        keys.forEach((k, j) => {
          const cell = room.board[k] || (room.board[k] = { letter: text[j], ownerIds: [], wordIds: [] });
          if (cell.letter !== text[j]) throw new Error(`Demo letter clash at ${k}`);
          cell.wordIds.push(id);
        });
      });
    }
    for (const k of Object.keys(room.board)) recomputeOwners(room, k);
    room.players.p1.rack = 'SPARKLINGHORIZONSE'.split('').map((l, i) => ({ id: `d1${i}`, letter: l }));
    room.players.p2.rack = 'MOUNTAINSTREAMLIGH'.split('').map((l, i) => ({ id: `d2${i}`, letter: l }));
    room.status = 'turn';
    room.currentTurnPlayerId = 'p1';
    checkWin(room, 'p1', 0);
    room.players.p2.connectedToEnd = !!findPath(room, 'p2');
    return room;
  }

  return {
    CONFIG, ROWS, PLAYER_IDS, PLAYERS, LETTER_WEIGHTS, DIRS, GameError,
    coordKey, parseKey, rc, keyOf, neighbors,
    hashString, roomRandom, buildDictionary, generateRack, canSpell, generateSpecials,
    createRoom, addPlayer, startGame, validatePlacement, applyPlacement, findPath, networkReach,
    checkWin, tick, applyCommand, publicState, buildDemoRoom, other,
  };
});
