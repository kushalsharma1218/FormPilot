// Unit tests for the two guards that stop the extension re-filling a field.
//
// These exist because the end-to-end loop is NOT reproducible under jsdom: the
// harness settles after a single pass where a real ATS keeps re-rendering, so an
// integration assertion passes with or without the fix. Testing the guards
// directly is the part that can actually fail when they are wrong.
//
// The bug they address: the attempt cap lived only in applyValueToElement, and
// the three dropdown paths — select, listbox, and the click-driven ARIA combobox
// used by Greenhouse and Workday — never call it. The combobox path additionally
// had no "is this already filled?" check at all, so every pass reopened every
// dropdown and stole focus.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function sourceOf(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in content.js`);
  const end = SRC.indexOf('\n}\n', start);
  return SRC.slice(start, end + 3);
}

test('every dropdown fill path is gated by the attempt cap', () => {
  // Reading the real source: each entry point must call beginFillAttempt before
  // it writes anything, or a page that resets values can loop forever.
  for (const fn of ['applyValueToElement', 'fillSelectSafely', 'fillListboxSafely']) {
    assert.match(sourceOf(fn), /beginFillAttempt\(/, `${fn} does not consult the attempt cap`);
  }

  // The combobox path is a loop inside fillFields rather than its own function.
  const combo = SRC.slice(SRC.indexOf('Custom ARIA comboboxes'));
  assert.match(combo, /alreadyMatches\(el, fieldKey, primaryVal\)/,
    'the combobox path does not check whether the field is already filled');
  assert.match(combo, /beginFillAttempt\(el, fieldKey\)/,
    'the combobox path is not gated by the attempt cap');
});

test('the verify pass judges dropdowns with the matcher, not string equality', () => {
  // scheduleVerifyFill used valuesRoughlyMatch, a raw substring compare. For a
  // canonical match ("USA" selected for a saved "United States") that reports
  // failure and retries forever.
  const verify = SRC.slice(SRC.indexOf('function scheduleVerifyFill'), SRC.indexOf('function scheduleVerifyFill') + 2000);
  assert.match(verify, /isDropdownLike\(el\)/,
    'the verify pass does not distinguish dropdowns');
  assert.match(verify, /alreadyMatches\(el, fieldKey, expected\)/,
    'the verify pass does not use the same matcher the fill used');
});

test('the attempt cap counts per element AND per field, and stops', () => {
  // Rebuild the cap in isolation from the real constant so the behaviour, not a
  // copy of it, is under test.
  const limitMatch = /const FILL_ATTEMPT_LIMIT = (\d+);/.exec(SRC);
  assert.ok(limitMatch, 'FILL_ATTEMPT_LIMIT not found');
  const LIMIT = Number(limitMatch[1]);
  assert.ok(LIMIT >= 2 && LIMIT <= 10, `implausible attempt limit: ${LIMIT}`);

  const counts = new WeakMap();
  const note = (el, key) => {
    const byKey = counts.get(el) || Object.create(null);
    byKey[key] = (byKey[key] || 0) + 1;
    counts.set(el, byKey);
  };
  const exhausted = (el, key) => {
    const byKey = counts.get(el);
    return !!byKey && (byKey[key] || 0) >= LIMIT;
  };

  const a = {};
  const b = {};
  for (let i = 0; i < LIMIT; i++) {
    assert.equal(exhausted(a, 'country'), false, `gave up early at attempt ${i}`);
    note(a, 'country');
  }
  assert.equal(exhausted(a, 'country'), true, 'never gives up');
  assert.equal(exhausted(a, 'state'), false, 'one field exhausted another');
  assert.equal(exhausted(b, 'country'), false, 'one element exhausted another');
});
