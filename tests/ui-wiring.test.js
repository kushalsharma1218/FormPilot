// Mechanical wiring checks for the extension's UI surfaces.
//
// These exist because a whole settings panel (the AI provider/key card) was
// implemented in dashboard.js against element ids that were never added to
// dashboard.html. Every AI feature was unreachable and nothing failed loudly —
// bindEvent() returns null on a missing id and the render function just returns.
// Nothing in a behavioural test suite catches that; a static cross-check does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Ids that are created at runtime rather than authored in the .html file.
const DYNAMIC_IDS = new Set(['auth-retry']);

function referencedIds(js) {
  const ids = new Set();
  for (const m of js.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/bindEvent\(\s*['"]([\w-]+)['"]/g)) ids.add(m[1]);
  return ids;
}

function definedIds(...sources) {
  const ids = new Set();
  for (const src of sources) {
    // Covers both static markup and ids written inside JS template literals.
    for (const m of src.matchAll(/id="([\w-]+)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]/g)) ids.add(m[1]);
  }
  return ids;
}

for (const [name, htmlPath, jsPath] of [
  ['popup', 'popup/popup.html', 'popup/popup.js'],
  ['dashboard', 'dashboard/dashboard.html', 'dashboard/dashboard.js'],
]) {
  test(`${name}: every element id the JS reaches for actually exists`, () => {
    const js = read(jsPath);
    const defined = definedIds(read(htmlPath), js);
    const missing = [...referencedIds(js)]
      .filter((id) => !defined.has(id) && !DYNAMIC_IDS.has(id))
      .sort();
    assert.deepEqual(missing, [], `${jsPath} references ids that no markup defines: ${missing.join(', ')}`);
  });
}

test('every message type the UI sends has a handler', () => {
  const senders = ['popup/popup.js', 'dashboard/dashboard.js', 'content.js'];
  const sent = new Set();
  for (const f of senders) {
    for (const m of read(f).matchAll(/sendMessage\(\s*\{\s*type:\s*'([A-Z_0-9]+)'/g)) sent.add(m[1]);
  }

  const handled = new Set();
  for (const m of read('background.js').matchAll(/case '([A-Z_0-9]+)'/g)) handled.add(m[1]);
  for (const m of read('content.js').matchAll(/msg\??\.type === '([A-Z_0-9]+)'/g)) handled.add(m[1]);

  const orphans = [...sent].filter((t) => !handled.has(t)).sort();
  assert.deepEqual(orphans, [], `no handler for: ${orphans.join(', ')}`);
});

test('no render function is defined but never called', () => {
  // renderCloudSync() was ~70 lines wired to ~90 more that nothing ever invoked.
  const js = read('dashboard/dashboard.js');
  const defined = [...js.matchAll(/^(?:async\s+)?function\s+(render[A-Z]\w*)/gm)].map((m) => m[1]);
  const uncalled = defined
    .filter((fn) => {
      const calls = js.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) || [];
      return calls.length <= 1; // the definition itself
    })
    .sort();
  assert.deepEqual(uncalled, [], `defined but never called: ${uncalled.join(', ')}`);
});
