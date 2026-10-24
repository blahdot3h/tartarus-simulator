#!/usr/bin/env node
/* Tartarus Simulator: a local copy of the site, for testing changes before
 * they're pushed. Serves this folder with caching off. With --live, each
 * page reloads itself when a site file changes. localhost counts as a secure
 * site, so features that need one (reading the game log, sharing a window)
 * work here. sandbox/ is served too: a gitignored folder for test files.
 *
 *   node tools/serve.js [--port 8080] [--live]
 *   then open http://localhost:8080/  (or /analyze.html?auto=1)
 *
 * The iPad mode keeps a record of a session here when opened with ?record=1
 * (analyze.html?record=1): each picture it read, what it made of it and its
 * advice, in sandbox/records/<start>/
 * (record.jsonl and pictures/). Don't use --live then: a reload ends the
 * capture.
 *
 * In VS Code, Run and Debug > "Local site" (F5) starts it with --live, and
 * restarts it when this file changes. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const PORT = Number(arg('port')) || 8080;
const LIVE = process.argv.includes('--live');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
// Folders the site doesn't serve, so a local copy doesn't either. The
// Worker's code is public (follow.html shows it); its secrets never are.
const PRIVATE = ['.git', '.vscode', 'node_modules', 'trainingdata', 'local', '.wrangler'];
const SECRET = /(^|[\\/])(\.dev\.vars|\.wrangler|\.env[^\\/]*)([\\/]|$)/;
const RECORDS = path.join(ROOT, 'sandbox', 'records');
const RUN_NAME = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}$/;
const PNG = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
const RECORD_LIMIT = 16 * 1024 * 1024;

// Only pages of this local site may write: any other site open in the browser
// could post to localhost too.
function allowedOrigin(origin, port) {
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}
// One line of a run's record, its picture (a PNG data URL) in a file of its own.
function writeRecord(dir, entry) {
  if (!entry || !RUN_NAME.test(String(entry.run))) throw new Error('Bad run name');
  const run = path.join(dir, entry.run);
  const line = Object.assign({}, entry);
  if (entry.png != null) {
    if (!Number.isInteger(entry.seq) || entry.seq < 0) throw new Error('Bad seq for a picture');
    const m = PNG.exec(String(entry.png));
    if (!m) throw new Error('Not a PNG picture');
    delete line.png;
    line.picture = `pictures/${String(entry.seq).padStart(4, '0')}.png`;
    fs.mkdirSync(path.join(run, 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(run, line.picture), Buffer.from(m[1], 'base64'));
  }
  fs.mkdirSync(run, { recursive: true });
  fs.appendFileSync(path.join(run, 'record.jsonl'), `${JSON.stringify(line)}\n`);
}
function record(req, res) {
  if (!allowedOrigin(req.headers.origin, PORT) || !/^application\/json\b/.test(req.headers['content-type'] || '')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= RECORD_LIMIT) chunks.push(c);
  });
  req.on('end', () => {
    if (size > RECORD_LIMIT) { res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Too large'); return; }
    try {
      writeRecord(RECORDS, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(204).end();
    } catch (e) {
      console.error(`record: ${e.message}`);
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(e.message);
    }
  });
}

// --live: pages listen here, and reload when a served file changes.
const listeners = new Set();
const RELOAD = '<script>(function(){var s=new EventSource("/__live");s.onmessage=function(){location.reload();};})();</script>';

function serve(req, res) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (rel === '/__record' && req.method === 'POST') {
    record(req, res);
    return;
  }
  if (LIVE && rel === '/__live') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': listening\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel));
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || PRIVATE.includes(top) || SECRET.test(path.relative(ROOT, file))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    let body = data;
    if (LIVE && ext === '.html') {
      const html = data.toString('utf8');
      body = html.includes('</body>') ? html.replace('</body>', `${RELOAD}</body>`) : html + RELOAD;
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

module.exports = { writeRecord, allowedOrigin, serve };
if (require.main !== module) return;

if (LIVE) {
  let timer = 0;
  fs.watch(ROOT, { recursive: true }, (event, name) => {
    if (!name) return;
    const top = name.split(/[\\/]/)[0];
    if (PRIVATE.includes(top) || /\.(swp|tmp)$|~$/.test(name) || /^sandbox[\\/]records([\\/]|$)/.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const res of listeners) res.write('data: reload\n\n');
      if (listeners.size) console.log(`${new Date().toLocaleTimeString()}  ${name} changed: reloaded ${listeners.size} page${listeners.size === 1 ? '' : 's'}`);
    }, 150);
  });
}

http.createServer(serve)
  .on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is the local site already running? Stop it, or use --port ${PORT + 1}.`);
    else console.error(e.message);
    process.exit(1);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`The site from ${ROOT}${LIVE ? ', reloading pages when files change' : ''}`);
    console.log(`  http://localhost:${PORT}/`);
    console.log(`  http://localhost:${PORT}/analyze.html?auto=1   (the analyzer with auto mode)`);
    console.log(`  http://localhost:${PORT}/sandbox/   (your test files)`);
    console.log('Stop: Ctrl+C, or the stop button in VS Code.');
  });
