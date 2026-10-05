# Word Path

A two-player, online word-path game. Create a game, send the link (or the five-character code) to a friend, and race to wire your start square to your end square.

- **Blue** builds from **A5 → Z22**. **Magenta** builds from **A22 → Z5**.
- Server-authoritative: the server deals racks, checks every word, runs the 35-second clocks, applies exchanges, deletions and specials, and detects the win.
- Each player only ever receives their own rack.

## What's in the box

```
index.html        The whole front end: home, lobby, game board, /demo, /rules
lib/engine.js     Game rules (pure JS). Runs on the server AND in the browser for live word previews
lib/store.js      Room storage: Upstash Redis over REST, with an in-memory fallback for local play
api/room.js       The one Vercel serverless function (create / join / poll / moves)
words.txt         ~111k-word English dictionary used by server and client
dev-server.js     Zero-dependency local server (mirrors Vercel's routing)
test/             Rule tests (node --test)
vercel.json       Rewrites for /play/CODE, /demo, /rules
```

No build step and no npm packages. Rule constants (timers, exchange costs, capacity, number of specials) live at the top of `lib/engine.js`.

---

## Walkthrough

### 1. Try it on your own computer (optional, 2 minutes)

You need Node.js 18 or newer.

```bash
node dev-server.js
```

Open http://localhost:3000. To play both sides yourself, open a **second tab** (each tab gets its own seat), create a game in one tab and paste the invite link into the other.

Run the rule tests with `npm test`.

### 2. Put the code on GitHub

1. Create a new repository on github.com (private is fine).
2. Upload every file in this folder, keeping the `api/`, `lib/` and `test/` folders. Drag-and-drop on the GitHub web page works, or:

```bash
git init && git add . && git commit -m "Word Path"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/word-path.git
git push -u origin main
```

### 3. Deploy to Vercel

1. Sign in at vercel.com → **Add New… → Project** → import the repository.
2. **Framework Preset: Other.** Leave Build Command and Output Directory empty.
3. Click **Deploy**.

The site loads now, but games can't be created yet. It needs a shared database because each Vercel function instance has its own memory. (If you try, the app tells you Redis isn't connected.)

### 4. Connect Upstash Redis

1. In your Vercel project, open **Storage** → **Create / Browse Marketplace** → **Upstash** → **Redis** (free plan is fine).
2. Create the database and **connect it to this project** for Production, Preview and Development.
3. Vercel adds the connection variables automatically. The code accepts either naming scheme:
   - `KV_REST_API_URL` + `KV_REST_API_TOKEN` (what the Vercel integration adds), or
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (if you create the database on upstash.com and paste them under **Settings → Environment Variables**).
4. **Deployments → ⋯ → Redeploy** so the function picks up the variables.

Rooms expire from Redis after 7 days.

### 5. Play with a friend

1. Open your Vercel URL, type your name, click **Create game**.
2. Click **Copy link** in the lobby and send it. Or read them the five-character code; they can type it under **Join with a code** on the home page.
3. Your friend opens the link, enters a name and clicks **Join game**.
4. Either player clicks **Start game**. The 35-second opening phase starts for both of you at once.

### How to place tiles

- **Click a square, then type.** The outline shows where the next letter goes; the arrow shows the direction.
- **Space** (or clicking the outlined square again) flips between **→ Across** and **↑ Up**. Vertical words read upward, from row A toward row Z.
- **Backspace** removes the last tile, **Esc** clears, **Enter** plays.
- Prefer the mouse? Click a rack tile, then a square. Right-click a placed tile to take it back.
- To build through a letter already on the board, put the cursor on it and type only your new letters.
- Under the board you'll see every word your move forms, with ✓ or ✗, before you submit.
- During the opening, the tile you put on your start square is your master letter. Blue can type a word starting on A5; magenta might click A22 and build upward.

---

## Rules as implemented

| Rule | Behaviour |
| --- | --- |
| Board | 26 × 26. Rows A–Z bottom→top, columns 1–26 left→right |
| Racks | 18 tiles: letters of a hidden 8-letter word + a hidden 6-letter word + 4 frequency-weighted letters. Seeded per room, so games are reproducible |
| Opening | Both players, 35 s, simultaneous. Word must cover your start square. Longer word moves first; ties and no-shows decided by the room seed. First words are locked |
| Turns | 35 s. One action: play a word, exchange, delete a word, or pass. Running out of time counts as a pass |
| Placement | Straight line, no gaps, real words only (including every cross-word formed), must use an existing tile you own |
| Exchange | 2 → 1 random (capacity −1). 3 → 1 chosen letter (capacity −2). Capacity can't go below 4 |
| Specials | Purple spiral: +1 capacity (max 24). Gold star: a wild tile. Triggered by covering it with a new tile; each works once |
| Shared tiles | A tile used in both players' words is owned by both and counts toward both paths |
| Delete | Your own words except your first. Tiles still used by another word stay |
| Win | BFS over your owned tiles (orthogonal only) from start to end. The winning route is animated |
| Draw | 8 passes/timeouts in a row ends the game |

Two choices worth knowing about, both one-line changes in `lib/engine.js`:

- `EXCHANGE_ENDS_TURN` / `DELETE_ENDS_TURN` (both `true`): the brief describes a turn as one action. Set to `false` to let players exchange or delete and then still play a word.
- `MAX_IDLE_TURNS` (8): stops abandoned games from ticking forever.

## How sync works

Clients poll `GET /api/room?code=…&v=<version>` about once per second; unchanged rooms answer with a tiny `{unchanged: true}`. Moves are `POST`s that take a short Redis lock, validate, apply and save. Timers are server deadlines; each browser counts down locally using the server's clock offset. Expired deadlines are applied by whichever request arrives first after them. Each poll is one Redis command, so check your Upstash plan's limits if you expect lots of simultaneous games.

## Next steps (from the project brief)

- Swap polling for WebSockets or a realtime provider when you move to Next.js. `lib/engine.js` ports directly; the commands map 1:1 to `ClientCommand`.
- Drag-and-drop tiles and better mobile layout.
- Sound, tutorial overlay, match history.
- Replace `words.txt` with any list you prefer (one word per line).
