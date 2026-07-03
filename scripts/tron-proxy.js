/**
 * Compatibility proxy: TronBox 4.x (TronWeb 6.x) <-> trontools/quickstart v2.x
 *
 * Listens on :9091, forwards to quickstart on :9090.
 * Rewrites API calls that changed between old and new TRON node versions.
 */
const http = require('http');

const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 9090;
const PROXY_PORT = 9091;

// TronWeb 6.x calls GET /wallet/getblock?detail=false (no num/id) to get the latest block.
// Old quickstart only has GET /wallet/getnowblock for this purpose.
const GETBLOCK_PATH = /^\/wallet\/getblock(\?.*)?$/i;

function forward(reqMethod, reqUrl, reqBody, res, originalHeaders = {}) {
  const headers = Object.assign({}, originalHeaders, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(reqBody),
    host: `${TARGET_HOST}:${TARGET_PORT}`,
  });
  delete headers['transfer-encoding'];

  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: reqUrl,
    method: reqMethod,
    headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });

  if (reqBody.length) proxyReq.write(reqBody);
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  let body = Buffer.alloc(0);

  req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });

  req.on('end', () => {
    // Rewrite: GET /wallet/getblock?detail=false (no num/id) → GET /wallet/getnowblock
    if (GETBLOCK_PATH.test(req.url)) {
      const qs = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
      const bodyParsed = body.length ? JSON.parse(body.toString()) : {};
      const hasId = qs.get('num') || qs.get('id') || bodyParsed.id_or_num || bodyParsed.num !== undefined;
      if (!hasId) {
        return forward('GET', '/wallet/getnowblock', Buffer.alloc(0), res, req.headers);
      }
    }

    forward(req.method, req.url, body, res, req.headers);
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`Tron proxy running on :${PROXY_PORT} → quickstart :${TARGET_PORT}`);
});
