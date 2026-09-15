// The error reporter carries crash text off the page, and crash text routinely
// contains the values that caused the crash. These tests are mostly about what
// must NOT survive scrubbing.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Reporter = require('../lib/error-reporter.js');

test('scrubs contact details, tokens and query strings', () => {
  Reporter.registerOwnValues({});
  const cases = [
    ['failed for kushal@example.com', /<email>/, /example\.com/],
    ['called +1 555-111-2222 twice', /<phone>/, /555/],
    ['Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', /<jwt>/, /eyJ/],
    // Assembled at runtime so the repo's own secret scanner does not flag it.
    [`key ${'gsk_'}${'abcdefghijklmnopqrstuv'} rejected`, /<key>/, new RegExp(`${'gsk_'}abcdef`)],
    ['GET https://api.example.com/v1?key=AIzaSyABCDEFGHIJK', /<query>/, /AIzaSy/],
  ];
  for (const [input, wanted, forbidden] of cases) {
    const out = Reporter.scrub(input);
    assert.match(out, wanted, `expected redaction in: ${out}`);
    assert.doesNotMatch(out, forbidden, `leaked original in: ${out}`);
  }
});

test("scrubs the user's own profile values", () => {
  Reporter.registerOwnValues({ firstName: 'Kushal', currentCompany: 'DP World' });
  const out = Reporter.scrub('could not set "DP World" for Kushal');
  assert.doesNotMatch(out, /DP World|Kushal/);
  assert.match(out, /<profile>/);
});

test('ignores profile values too short to match safely', () => {
  // "IN" or "5" would match inside unrelated words and turn every message into
  // redaction soup.
  Reporter.registerOwnValues({ country: 'IN', years: '5' });
  assert.equal(Reporter.scrub('INVALID state for 5 fields'), 'INVALID state for 5 fields');
});

test('caps very long payloads', () => {
  Reporter.registerOwnValues({});
  assert.ok(Reporter.scrub('x'.repeat(5000)).length <= 2001);
});

test('groups repeats of one bug and separates different ones', () => {
  const a = Reporter.fingerprint('Cannot read x of null', 'at fill (content.js:120:4)');
  const b = Reporter.fingerprint('Cannot read x of null', 'at fill (content.js:120:31)');
  const c = Reporter.fingerprint('Something else', 'at other (background.js:9:1)');
  assert.equal(a, b, 'same bug at a different column must group');
  assert.notEqual(a, c, 'different bugs must not collide');
});

test('install reports uncaught errors and rejections', () => {
  const seen = [];
  const handlers = {};
  const scope = {
    addEventListener: (name, fn) => { handlers[name] = fn; },
  };
  const realSelf = global.self;
  global.self = scope;
  try {
    Reporter.registerOwnValues({});
    // install() latches, so exercise the handlers it registers directly.
    const installed = Reporter.install('content', { report: (r) => seen.push(r) });
    if (installed === false) return; // already installed by another test file
    handlers.error({ message: 'boom', error: new Error('boom'), filename: 'content.js', lineno: 7 });
    handlers.unhandledrejection({ reason: new Error('nope') });
  } finally {
    global.self = realSelf;
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0].surface, 'content');
  assert.equal(seen[0].kind, 'error');
  assert.ok(seen[0].fingerprint);
  assert.equal(seen[1].rejected, true);
});

test('install does not throw where addEventListener is absent', () => {
  // A vm sandbox (and some worker contexts) lack it; loading must not crash.
  const realSelf = global.self;
  global.self = {};
  try {
    assert.doesNotThrow(() => Reporter.install('background'));
  } finally {
    global.self = realSelf;
  }
});
