// Zero-dependency local server: `node dev-server.js` → http://localhost:3000
// Serves the static app, mirrors vercel.json rewrites, and runs /api/room in-process
// (rooms live in memory unless Upstash env vars are set).
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api/room');

const PORT = Number(process.env.PORT || 3000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/room') return handler(req, res);
  let file = url.pathname;
  if (file === '/' || /^\/(play\/[^/]+|demo|rules)\/?$/.test(file)) file = '/index.html';
  const full = path.join(__dirname, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(__dirname) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404; return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(full)] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => console.log(`Word Path running at http://localhost:${PORT}`));
