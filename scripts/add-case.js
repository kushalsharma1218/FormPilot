#!/usr/bin/env node
/**
 * scripts/add-case.js — turn a field that filled wrongly into a permanent test.
 *
 * This is the loop that stops matching work being whack-a-mole. When a real form
 * misbehaves, the label goes into the corpus FIRST as a failing case; only then
 * is the matcher changed. The ratchet in health-check then guarantees it never
 * comes back.
 *
 *   npm run add-case -- --label "Notice period in days" --expect noticePeriod
 *   npm run add-case -- --label "Referrer's email" --expect none --type email
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
}

const label = arg('label');
const expectRaw = arg('expect');
if (!label || expectRaw === null) {
  console.error('usage: npm run add-case -- --label "<form label>" --expect <profileKey|none> [--tag input|select|textarea] [--type email|tel|number|password]');
  process.exit(2);
}

const CORPUS = path.join(__dirname, '..', 'tests/fixtures/field-match-cases.json');
const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));

if (corpus.cases.some((c) => c.label === label)) {
  console.error(`already in the corpus: "${label}"`);
  process.exit(1);
}

const expect = /^(none|null|)$/i.test(expectRaw) ? null : expectRaw;
if (expect && !(expect in corpus.profile)) {
  console.error(`"${expect}" is not a field in the corpus profile. Known: ${Object.keys(corpus.profile).join(', ')}`);
  process.exit(1);
}

const entry = { label, tag: arg('tag') || 'input', expect };
if (arg('type')) entry.type = arg('type');
if (arg('note')) entry.note = arg('note');

corpus.cases.push(entry);
fs.writeFileSync(CORPUS, JSON.stringify(corpus, null, 2) + '\n');

console.log(`added: "${label}" -> ${expect === null ? '(must not fill)' : expect}`);
console.log('now run `npm run health` — it should FAIL until the matcher handles it.');
