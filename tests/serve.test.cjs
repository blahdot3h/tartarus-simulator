const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { writeRecord, allowedOrigin, serve } = require('../tools/serve.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tartarus-records-'));
const RUN = '2026-10-22T18-04-05-123';

test('a record line goes to its run, and its picture to a file of its own', () => {
  const dir = tmp();
  writeRecord(dir, { run: RUN, seq: 1, type: 'connect', surface: 'window' });
  writeRecord(dir, { run: RUN, seq: 2, type: 'frame', png: `data:image/png;base64,${Buffer.from('png!').toString('base64')}` });
  const lines = fs.readFileSync(path.join(dir, RUN, 'record.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['connect', 'frame']);
  assert.equal(lines[1].png, undefined);
  assert.equal(lines[1].picture, 'pictures/0002.png');
  assert.equal(fs.readFileSync(path.join(dir, RUN, 'pictures', '0002.png'), 'utf8'), 'png!');
});

test('a run name or a sequence that could leave the records folder is refused', () => {
  const dir = tmp();
  assert.throws(() => writeRecord(dir, { run: '../../etc', seq: 1, type: 'x' }), /run/);
  assert.throws(() => writeRecord(dir, { run: RUN, seq: '../1', type: 'x', png: 'data:image/png;base64,AA==' }), /seq/);
  assert.throws(() => writeRecord(dir, { run: RUN, seq: 1, type: 'x', png: 'data:text/html;base64,AA==' }), /picture/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('only the local site itself may write records', () => {
  assert.equal(allowedOrigin('http://localhost:8080', 8080), true);
  assert.equal(allowedOrigin('http://127.0.0.1:8080', 8080), true);
  assert.equal(allowedOrigin('http://localhost:9090', 8080), false);
  assert.equal(allowedOrigin('https://evil.example', 8080), false);
  assert.equal(allowedOrigin(undefined, 8080), false);
});

function request(server, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port: server.address().port }, options), (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
test('the record endpoint refuses other sites and plain text, and answers a too large body with 413', async () => {
  const server = http.createServer(serve).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const json = { 'Content-Type': 'application/json' };
    assert.equal(await request(server, { method: 'POST', path: '/__record', headers: Object.assign({ Origin: 'https://evil.example' }, json) }, '{}'), 403);
    assert.equal(await request(server, { method: 'POST', path: '/__record', headers: { Origin: 'http://localhost:8080', 'Content-Type': 'text/plain' } }, '{}'), 403);
    assert.equal(await request(server, { method: 'POST', path: '/__record', headers: Object.assign({ Origin: 'http://localhost:8080' }, json) }, Buffer.alloc(17 * 1024 * 1024, 32)), 413);
    assert.equal(await request(server, { method: 'GET', path: '/__record' }), 404);
  } finally { server.close(); }
});
