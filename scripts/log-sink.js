#!/usr/bin/env node
/**
 * scripts/log-sink.js — a local landing pad for extension diagnostics.
 *
 * A Chrome extension's logs live in the browser; there is no file to tail. This
 * gives them somewhere on disk to go, so a watcher (or you) can react to a crash
 * as it happens rather than discovering it later in devtools.
 *
 * Deliberately local-only and opt-in:
 *   - binds 127.0.0.1, so nothing off this machine can reach it
 *   - the extension sends nothing unless you set the sink URL in Settings
 *   - records are already scrubbed of emails, phones, tokens and profile values
 *     by lib/error-reporter.js before they leave the browser
 *
 *   npm run sink              listen on 127.0.0.1:8787
 *   PORT=9000 npm run sink
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);
const OUT_DIR = path.join(__dirname, '..', '.diagnostics');
const OUT_FILE = path.join(OUT_DIR, 'errors.jsonl');

fs.mkdirSync(OUT_DIR, { recursive: true });

let received = 0;

const server = http.createServer((req, res) => {
  // The extension page's origin is chrome-extension://<id>; allow it to POST.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`formpilot log sink\nreceived: ${received}\nfile: ${OUT_FILE}\n`);
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) { req.destroy(); } // no unbounded buffering
  });
  req.on('end', () => {
    let records;
    try {
      const parsed = JSON.parse(body);
      records = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      res.writeHead(400); return res.end('bad json');
    }

    const lines = records
      .map((r) => JSON.stringify({ receivedAt: new Date().toISOString(), ...r }))
      .join('\n');
    fs.appendFileSync(OUT_FILE, lines + '\n');
    received += records.length;

    for (const r of records) {
      const where = [r.surface, r.host].filter(Boolean).join('/');
      process.stdout.write(`  ${r.kind === 'error' ? 'ERROR' : 'log  '} [${where}] ${String(r.message || '').slice(0, 120)}\n`);
    }

    res.writeHead(204);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  log sink listening on http://127.0.0.1:${PORT}`);
  console.log(`  writing to ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log(`\n  Turn it on in the extension: Dashboard -> Settings -> Diagnostics sink\n`);
});
