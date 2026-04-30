const http = require('http');
const https = require('https');
const url = require('url');

const UPSTREAM = 'https://app.opencode.ai';

function proxyRequest(req, res) {
  const target = UPSTREAM + req.url;
  const parsed = new URL(target);

  const options = {
    hostname: parsed.hostname,
    port: 443,
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: parsed.hostname,
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Rewrite CSP to allow connecting back to our local server
    const headers = { ...proxyRes.headers };
    delete headers['content-security-policy'];
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway: ' + err.message);
  });

  req.pipe(proxyReq);
}

const server = http.createServer(proxyRequest);

server.listen(3000);
