const http = require('http');
const https = require('https');

const UPSTREAM = process.env.ALMOSTNODE_UPSTREAM || 'https://app.opencode.ai';
const PORT = Number(process.env.ALMOSTNODE_PORT || 3000);
// Development-only proxy: loopback so nothing else on the network can reach it.
const HOST = '127.0.0.1';
// Opt-in escape hatch for local tooling that genuinely needs its session forwarded.
const FORWARD_CREDENTIALS = process.env.ALMOSTNODE_FORWARD_CREDENTIALS === '1';

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function upstreamHeaders(incoming, host, forwardCredentials) {
  const nominated = String(incoming.connection || '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || nominated.includes(lower)) continue;
    if (CREDENTIAL_HEADERS.has(lower) && !forwardCredentials) continue;
    headers[lower] = value;
  }
  headers.host = host;
  return headers;
}

function createProxy(upstream = UPSTREAM, { forwardCredentials = FORWARD_CREDENTIALS } = {}) {
  // Concatenating instead of new URL(req.url, upstream) keeps the upstream host pinned
  // when a client sends absolute-form request targets.
  const transport = upstream.startsWith('https:') ? https : http;
  return http.createServer((req, res) => {
    const parsed = new URL(upstream + req.url);

    const proxyReq = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: upstreamHeaders(req.headers, parsed.host, forwardCredentials),
      },
      (proxyRes) => {
        // Rewrite CSP to allow connecting back to our local server
        const headers = { ...proxyRes.headers };
        delete headers['content-security-policy'];
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: ' + err.message);
    });

    req.pipe(proxyReq);
  });
}

if (require.main === module) {
  createProxy().listen(PORT, HOST);
}

module.exports = { createProxy, upstreamHeaders };
