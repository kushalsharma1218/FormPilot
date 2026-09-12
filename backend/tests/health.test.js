const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('../index');

test('GET /health responds with ok status', async () => {
  const server = app.listen(0);
  const port = server.address().port;

  const body = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });

  server.close();

  assert.equal(body.status, 200);
  const parsed = JSON.parse(body.data);
  assert.equal(parsed.status, 'ok');
});

test('rejects a request from a disallowed origin', async () => {
  const server = app.listen(0);
  const port = server.address().port;

  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/parse-resume', method: 'POST', headers: { Origin: 'https://evil.example' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', reject);
    req.end();
  });

  server.close();
  assert.equal(status, 403);
});

test('rate limits repeated requests to the parse route', async () => {
  const server = app.listen(0);
  const port = server.address().port;

  const send = () => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/parse-resume', method: 'POST' },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', reject);
    req.end();
  });

  let sawLimit = false;
  for (let i = 0; i < 15; i++) {
    if (await send() === 429) { sawLimit = true; break; }
  }

  server.close();
  assert.ok(sawLimit, 'expected a 429 within 15 requests');
});
