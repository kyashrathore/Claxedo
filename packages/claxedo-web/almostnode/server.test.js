const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createProxy } = require('./server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function send(port, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/foo?x=1', method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function throughProxy(upstreamHandler, sendOptions, proxyOptions) {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = { headers: req.headers, method: req.method, url: req.url };
    upstreamHandler(req, res);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxy(`http://127.0.0.1:${String(upstreamPort)}`, proxyOptions);
  const proxyPort = await listen(proxy);
  try {
    const res = await send(proxyPort, sendOptions);
    return { res, seen };
  } finally {
    proxy.close();
    upstream.close();
  }
}

void test('strips credentials and hop-by-hop headers, keeps the rest', async () => {
  const { res, seen } = await throughProxy(
    (req, r) => r.end('upstream-ok'),
    {
      headers: {
        authorization: 'Bearer secret-token',
        cookie: 'session=secret',
        'proxy-authorization': 'Basic abc',
        'x-requested-with': 'fetch',
        connection: 'keep-alive, x-hop-token',
        'x-hop-token': 'hop-secret',
      },
    },
  );

  assert.equal(res.status, 200);
  assert.equal(res.body, 'upstream-ok');
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers['proxy-authorization'], undefined);
  assert.equal(seen.headers['x-hop-token'], undefined);
  assert.equal(seen.headers['x-requested-with'], 'fetch');
});

void test('forwards credentials only when explicitly enabled', async () => {
  const { seen } = await throughProxy(
    (req, r) => r.end('ok'),
    { headers: { authorization: 'Bearer secret-token', cookie: 'session=secret' } },
    { forwardCredentials: true },
  );

  assert.equal(seen.headers.authorization, 'Bearer secret-token');
  assert.equal(seen.headers.cookie, 'session=secret');
});

void test('forwards method, path and body; drops upstream CSP; host pinned to upstream', async () => {
  const { res, seen } = await throughProxy(
    (req, r) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        r.writeHead(200, { 'content-security-policy': "default-src 'none'", 'content-type': 'text/plain' });
        r.end('body:' + Buffer.concat(chunks).toString());
      });
    },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
  );

  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/foo?x=1');
  assert.equal(res.body, 'body:{"a":1}');
  assert.equal(res.headers['content-security-policy'], undefined);
  // Host is rewritten to the upstream authority, not the caller's Host header.
  assert.match(seen.headers.host, /^127\.0\.0\.1:\d+$/);
});

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForListen(port) {
  for (let i = 0; i < 50; i++) {
    if (await canConnect('127.0.0.1', port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('proxy did not start listening');
}

void test('standalone server binds loopback only', async (t) => {
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal);
  if (!external) {
    t.skip('no non-loopback interface to test against');
    return;
  }

  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));

  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, ALMOSTNODE_PORT: String(port) },
    stdio: 'ignore',
  });
  try {
    await waitForListen(port);
    assert.equal(await canConnect(external.address, port), false);
  } finally {
    child.kill();
  }
});
