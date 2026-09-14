#!/usr/bin/env node
/**
 * scripts/triage-logs.js — turn a stream of crashes into a ranked worklist.
 *
 * Raw logs are useless for deciding what to fix: one re-render loop firing four
 * hundred times buries the single crash that actually breaks submission. This
 * groups by fingerprint, ranks by how many distinct SITES hit each bug rather
 * than raw count (a bug seen on five portals matters more than one seen five
 * hundred times on one), and points at the source line.
 *
 *   npm run triage                 read .diagnostics/errors.jsonl
 *   npm run triage -- --json       machine-readable, for an agent
 *   npm run triage -- --since 2h
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');

function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
}

const FILE = arg('file') || path.join(ROOT, '.diagnostics', 'errors.jsonl');

function sinceMs() {
  const raw = arg('since');
  if (!raw) return 0;
  const m = /^(\d+)([mhd])$/.exec(raw);
  if (!m) return 0;
  const mult = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return Date.now() - Number(m[1]) * mult;
}

if (!fs.existsSync(FILE)) {
  console.error(`no diagnostics at ${path.relative(process.cwd(), FILE)}\nStart the sink with \`npm run sink\` and enable it in the dashboard.`);
  process.exit(1);
}

const cutoff = sinceMs();
const records = fs.readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
  .filter(Boolean)
  .filter((r) => !cutoff || Date.parse(r.receivedAt || r.at || 0) >= cutoff);

const groups = new Map();
for (const r of records) {
  if (r.kind !== 'error') continue;
  const id = r.fingerprint || r.message || 'unknown';
  if (!groups.has(id)) {
    groups.set(id, { id, message: r.message, stack: r.stack, surfaces: new Set(), hosts: new Set(), count: 0, first: r.at, last: r.at });
  }
  const g = groups.get(id);
  g.count++;
  if (r.surface) g.surfaces.add(r.surface);
  if (r.host) g.hosts.add(r.host);
  if (r.at && r.at < g.first) g.first = r.at;
  if (r.at && r.at > g.last) g.last = r.at;
}

// Where in our own source did it come from?
function locate(stack) {
  // Stack frames read "at fn (content.js:3520:18)" — the filename is preceded by
  // a paren, not a slash, so anchoring on "/" matched nothing.
  const m = /((?:lib\/|scripts\/|dashboard\/|popup\/)?[\w.-]+\.js):(\d+)/.exec(String(stack || ''));
  if (!m) return null;
  const file = m[1];
  const line = Number(m[2]);
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return { file, line, source: null };
  const src = fs.readFileSync(full, 'utf8').split('\n');
  return { file, line, source: (src[line - 1] || '').trim().slice(0, 120) };
}

const ranked = [...groups.values()]
  .map((g) => ({
    id: g.id,
    message: g.message,
    count: g.count,
    surfaces: [...g.surfaces],
    sites: g.hosts.size,
    hosts: [...g.hosts].slice(0, 5),
    first: g.first,
    last: g.last,
    at: locate(g.stack),
  }))
  // Breadth first, then volume: a bug on many sites is more important than a
  // loud one on a single page.
  .sort((a, b) => (b.sites - a.sites) || (b.count - a.count));

if (JSON_OUT) {
  console.log(JSON.stringify({ file: FILE, records: records.length, groups: ranked }, null, 2));
  process.exit(0);
}

if (!ranked.length) {
  console.log(`\n  no errors in ${records.length} records — nothing to triage\n`);
  process.exit(0);
}

console.log(`\n  ${ranked.length} distinct error(s) across ${records.length} records\n`);
ranked.forEach((g, i) => {
  console.log(`  ${i + 1}. [${g.id}] seen ${g.count}x on ${g.sites} site(s) — ${g.surfaces.join(', ') || 'unknown surface'}`);
  console.log(`     ${g.message}`);
  if (g.at) {
    console.log(`     ${g.at.file}:${g.at.line}${g.at.source ? `  ${g.at.source}` : ''}`);
  }
  if (g.hosts.length) console.log(`     sites: ${g.hosts.join(', ')}`);
  console.log('');
});
