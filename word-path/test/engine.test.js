const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WP = require('../lib/engine');

const dict = WP.buildDictionary(fs.readFileSync(path.join(__dirname, '..', 'words.txt'), 'utf8'));

function freshGame(seed = 'test-seed') {
  const room = WP.createRoom({ code: 'TEST', seed, now: 0 });
  WP.addPlayer(room, 'p1', 'Ann');
  WP.addPlayer(room, 'p2', 'Ben');
  WP.startGame(room, dict, 0);
  room.specials = {}; // keep specials out of the way unless a test sets them
  return room;
}
// Give a player a known rack so placements are predictable.
function setRack(room, pid, letters) {
  room.players[pid].rack = letters.split('').map((l, i) => ({ id: `${pid}x${i}`, letter: l }));
}
// Build placements for `word` starting at startKey, reusing letters already on the board.
function place(room, pid, word, startKey, orientation) {
  const d = WP.DIRS[orientation];
  const s = WP.rc(startKey);
  const rack = [...room.players[pid].rack];
  const out = [];
  word.split('').forEach((ch, i) => {
    const key = WP.keyOf(s.r + d.dr * i, s.c + d.dc * i);
    if (room.board[key]) return;
    const idx = rack.findIndex((t) => t.letter === ch);
    out.push({ tileId: rack[idx].id, key });
    rack.splice(idx, 1);
  });
  return out;
}
function openBoth(room, p1Word = 'TREE', p2Word = 'FIRE') {
  setRack(room, 'p1', 'TREESARTHONGLAKEAA');
  setRack(room, 'p2', 'FIREASTIDEMOONLAKE');
  WP.applyCommand(room, 'p1', { type: 'SUBMIT_OPENING_WORD', placements: place(room, 'p1', p1Word, 'A5', 'vertical') }, dict, 1);
  WP.applyCommand(room, 'p2', { type: 'SUBMIT_OPENING_WORD', placements: place(room, 'p2', p2Word, 'A22', 'vertical') }, dict, 2);
}

test('coordinates: A1 bottom-left, Z26 top-right, keys round-trip', () => {
  assert.deepEqual(WP.rc('A1'), { r: 0, c: 0 });
  assert.deepEqual(WP.rc('Z26'), { r: 25, c: 25 });
  assert.equal(WP.coordKey({ row: 'Z', col: 22 }), 'Z22');
  assert.equal(WP.parseKey('A27'), null);
  assert.equal(WP.parseKey('a5'), null);
  assert.equal(WP.PLAYERS.p1.start, 'A5'); assert.equal(WP.PLAYERS.p1.end, 'Z22');
  assert.equal(WP.PLAYERS.p2.start, 'A22'); assert.equal(WP.PLAYERS.p2.end, 'Z5');
});

test('rack: 18 tiles, deterministic from seed, spells a 6- and an 8-letter word', () => {
  for (const seed of ['seed-1', 'seed-2', 'seed-3']) {
    const a = freshGame(seed), b = freshGame(seed);
    for (const pid of ['p1', 'p2']) {
      const rack = a.players[pid].rack;
      assert.equal(rack.length, 18);
      assert.deepEqual(rack.map((t) => t.letter), b.players[pid].rack.map((t) => t.letter));
      assert.ok(dict.byLength[8].some((w) => WP.canSpell(rack, w)), '8-letter word');
      assert.ok(dict.byLength[6].some((w) => WP.canSpell(rack, w)), '6-letter word');
    }
  }
});

test('opening word must put its master letter on the start square', () => {
  const room = freshGame();
  setRack(room, 'p1', 'STARLIGHTEOUMNPRSA');
  assert.match(WP.validatePlacement(room, 'p1', place(room, 'p1', 'STAR', 'B5', 'horizontal'), dict).error, /A5/);
  assert.ok(WP.validatePlacement(room, 'p1', place(room, 'p1', 'STAR', 'A4', 'horizontal'), dict).ok, 'T is the master letter on A5');
});

test('straight line, no gaps, dictionary', () => {
  const room = freshGame();
  setRack(room, 'p1', 'CATDOGXQZZEEAARRST');
  assert.match(WP.validatePlacement(room, 'p1', [{ tileId: 'p1x0', key: 'A5' }, { tileId: 'p1x1', key: 'B6' }], dict).error, /straight/);
  assert.match(WP.validatePlacement(room, 'p1', [{ tileId: 'p1x0', key: 'A5' }, { tileId: 'p1x1', key: 'A6' }, { tileId: 'p1x2', key: 'A8' }], dict).error, /gap/i);
  assert.match(WP.validatePlacement(room, 'p1', place(room, 'p1', 'XQZ', 'A5', 'horizontal'), dict).error, /dictionary/);
});

test('opening: longer word moves first; first words are locked', () => {
  const room = freshGame();
  openBoth(room, 'TREES', 'FIRE');
  assert.equal(room.status, 'turn');
  assert.equal(room.currentTurnPlayerId, 'p1');
  const first = room.words[room.players.p1.firstWordId];
  assert.ok(first.lockedFirstWord);
  assert.throws(() => WP.applyCommand(room, 'p1', { type: 'DELETE_WORD', wordId: first.id }, dict, 3), /locked/);
});

test('connection rule, shared ownership, deleting non-first words', () => {
  const room = freshGame();
  openBoth(room);
  room.currentTurnPlayerId = 'p1';
  setRack(room, 'p1', 'ARTHSONGXXXXXXXXXX');
  assert.throws(() => WP.applyCommand(room, 'p1', { type: 'PLACE_WORD', placements: place(room, 'p1', 'SONG', 'J10', 'horizontal') }, dict, 3), /connect/);
  WP.applyCommand(room, 'p1', { type: 'PLACE_WORD', placements: place(room, 'p1', 'EARTH', 'D5', 'horizontal') }, dict, 4);
  const earth = Object.values(room.words).find((w) => w.text === 'EARTH');
  assert.equal(room.board.D5.wordIds.length, 2, 'D5 is in TREE and EARTH');

  // Player 2 uses Player 1's H in a legal word → shared tile.
  WP.applyPlacement(room, 'p2', { placed: [{ key: 'E9', letter: 'O', tileId: 'none' }], words: [{ keys: ['D9', 'E9'], text: 'HO', orientation: 'vertical' }] }, 5);
  assert.deepEqual(room.board.D9.ownerIds, ['p1', 'p2']);

  room.currentTurnPlayerId = 'p1';
  WP.applyCommand(room, 'p1', { type: 'DELETE_WORD', wordId: earth.id }, dict, 6);
  assert.ok(room.board.D5, 'shared with TREE, stays');
  assert.equal(room.board.D7, undefined, 'only in EARTH, removed');
  assert.deepEqual(room.board.D9.ownerIds, ['p2'], 'still in HO');
});

test('exchanges reduce capacity; specials grant capacity and wilds', () => {
  const room = freshGame();
  openBoth(room);
  const pid = room.currentTurnPlayerId;
  const p = room.players[pid];
  const cap = p.capacity;
  WP.applyCommand(room, pid, { type: 'EXCHANGE_RANDOM', tileIds: p.rack.slice(0, 2).map((t) => t.id) }, dict, 3);
  assert.equal(p.capacity, cap - 1);
  room.currentTurnPlayerId = pid;
  WP.applyCommand(room, pid, { type: 'EXCHANGE_SPECIFIC', tileIds: p.rack.slice(0, 3).map((t) => t.id), desiredLetter: 'q' }, dict, 4);
  assert.equal(p.capacity, cap - 3);
  assert.ok(p.rack.some((t) => t.letter === 'Q'));

  room.currentTurnPlayerId = 'p1';
  room.specials = { D6: { type: 'inventory_plus', consumedBy: null }, D8: { type: 'wild_star', consumedBy: null } };
  setRack(room, 'p1', 'ARTHXXXXXXXXXXXXXX');
  const before = room.players.p1.capacity;
  WP.applyCommand(room, 'p1', { type: 'PLACE_WORD', placements: place(room, 'p1', 'EARTH', 'D5', 'horizontal') }, dict, 5);
  assert.equal(room.players.p1.capacity, before + 1);
  assert.equal(room.specials.D6.consumedBy, 'p1');
  assert.equal(room.players.p1.wildTokens, 1);
});

test('demo board: Player 1 wins along an orthogonal route, Player 2 does not', () => {
  const room = WP.buildDemoRoom();
  assert.equal(room.winnerId, 'p1');
  assert.equal(room.winningPathCoords[0], 'A5');
  assert.equal(room.winningPathCoords.at(-1), 'Z22');
  assert.equal(WP.findPath(room, 'p2'), null);
  for (let i = 1; i < room.winningPathCoords.length; i++) {
    assert.ok(WP.neighbors(room.winningPathCoords[i - 1]).includes(room.winningPathCoords[i]));
  }
});

test('timeouts advance the turn; idle games end in a draw', () => {
  const room = freshGame();
  WP.tick(room, dict, WP.CONFIG.OPENING_MS + 1);
  assert.equal(room.status, 'turn');
  let t = WP.CONFIG.OPENING_MS + 1;
  for (let i = 0; i < WP.CONFIG.MAX_IDLE_TURNS; i++) { t += WP.CONFIG.TURN_MS + 1; WP.tick(room, dict, t); }
  assert.equal(room.status, 'finished');
  assert.equal(room.endReason, 'idle');
});

test('public state hides the opponent rack', () => {
  const room = freshGame();
  const s = WP.publicState(room, 'p1');
  assert.equal(s.me.rack.length, 18);
  assert.equal(s.players.p2.rack, undefined);
  assert.equal(s.players.p2.rackCount, 18);
});
