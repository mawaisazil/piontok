#!/usr/bin/env node
/**
 * PionTok — Local development server with URL-history logging.
 *
 * This server does two things:
 *   1. Serves the static webapp files (index.html, manifest.json, sw.js, etc.)
 *   2. Accepts POST /log requests and appends each pasted URL to history.json
 *      in the same directory as this script.
 *
 * The webapp silently POSTs every pasted/submitted URL to /log via
 * navigator.sendBeacon(). The log is NOT shown in the webapp UI — it's a
 * separate server-side record for the developer's reference.
 *
 * Usage:
 *   node server.js            # serves on http://localhost:8080
 *   node server.js 3000       # serves on http://localhost:3000
 *
 * The history.json file is created automatically on the first logged URL.
 * Each entry looks like:
 *   {
 *     "url": "https://www.tiktok.com/@user/video/123",
 *     "platform": "tiktok",
 *     "timestamp": "2026-06-25T12:34:56.789Z",
 *     "userAgent": "Mozilla/5.0 ..."
 *   }
 */

const http = require('http');
const fs = require('fs');
const path = require('url').pathToFileURL || (p => p); // polyfill noop

const PORT = parseInt(process.argv[2] || '8080', 10);
const ROOT = __dirname;
const HISTORY_FILE = require('path').join(ROOT, 'history.json');

// MIME types for static file serving
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
};

/** Safely resolve a file path inside ROOT (prevents path traversal) */
function safeResolve(reqPath) {
  const p = require('path');
  let relative = reqPath.split('?')[0];
  if (relative === '/' || relative === '') relative = '/index.html';
  // Strip leading slash
  relative = relative.replace(/^\/+/, '');
  const resolved = p.resolve(ROOT, relative);
  // Ensure the resolved path is still inside ROOT
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

/** Append a JSON record to history.json (creates the file if missing) */
function appendToHistory(record) {
  try {
    let existing = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
        existing = JSON.parse(raw);
        if (!Array.isArray(existing)) existing = [];
      } catch { existing = []; }
    }
    existing.push(record);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error('[history] Failed to write:', e.message);
    return false;
  }
}

/** Read the request body as a string (with size limit) */
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // CORS + security headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /log — append the URL to history.json
  if (method === 'POST' && (url === '/log' || url.startsWith('/log?'))) {
    try {
      const bodyText = await readBody(req);
      let record;
      try {
        record = JSON.parse(bodyText);
      } catch {
        record = { url: bodyText, platform: 'unknown', timestamp: new Date().toISOString() };
      }
      // Ensure required fields
      if (!record.timestamp) record.timestamp = new Date().toISOString();
      if (!record.url) record.url = '(empty)';
      if (!record.platform) record.platform = 'unknown';
      // Add server-side IP (anonymized) for debugging
      record.ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

      const ok = appendToHistory(record);
      if (ok) {
        console.log(`[history] ${record.timestamp} | ${record.platform} | ${record.url.slice(0, 80)}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /history.json — serve the log file (for developer inspection)
  if (method === 'GET' && url === '/history.json') {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // Static file serving
  const filePath = safeResolve(url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // If the path doesn't have an extension, try serving index.html (SPA fallback)
      if (!require('path').extname(filePath)) {
        const indexFile = require('path').join(ROOT, 'index.html');
        if (fs.existsSync(indexFile)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          fs.createReadStream(indexFile).pipe(res);
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = require('path').extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('┌──────────────────────────────────────────────────────────┐');
  console.log('│  PionTok local server                                    │');
  console.log(`│  Listening on  http://localhost:${PORT}                       │`);
  console.log(`│  Webapp dir    ${ROOT}`);
  console.log(`│  URL log file  ${HISTORY_FILE}`);
  console.log('│                                                          │');
  console.log('│  Every pasted URL will be appended to history.json.      │');
  console.log('│  Inspect the log at http://localhost:' + PORT + '/history.json');
  console.log('└──────────────────────────────────────────────────────────┘');
});
