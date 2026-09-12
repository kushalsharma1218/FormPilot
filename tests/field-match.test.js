// Evaluates label -> profile-key matching against a hand-labelled corpus.
//
// Precision is the number that matters. A missed field costs one keystroke; a
// WRONG field is written into the page and then learned back into the profile by
// maybeAutoLearnProfile, so a precision failure corrupts stored data. The old
// first-match-wins regex table scored 70.3% precision on this corpus — it filled
// an employer name into "Current Company Notice Period (number of days)".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FieldMatch = require('../lib/field-match.js');
const corpus = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'field-match-cases.json'), 'utf8')
);

function evaluate() {
  const { profile, cases } = corpus;
  let tp = 0, fp = 0, fn = 0;
  const failures = [];
  for (const c of cases) {
    const result = FieldMatch.matchField(c, profile);
    const got = result ? result.key : null;
    if (got === c.expect) { if (c.expect) tp++; continue; }
    if (got && !c.expect) { fp++; failures.push(`filled "${c.label}" with ${got} (should stay empty)`); }
    else if (!got && c.expect) { fn++; failures.push(`missed "${c.label}" (expected ${c.expect})`); }
    else { fp++; fn++; failures.push(`"${c.label}" -> ${got}, expected ${c.expect}`); }
  }
  return { tp, fp, fn, failures, total: cases.length };
}

test('matching precision does not regress', () => {
  const { tp, fp, failures } = evaluate();
  const precision = tp / (tp + fp || 1);
  assert.ok(
    precision >= 0.95,
    `precision ${(100 * precision).toFixed(1)}% (baseline before the typed matcher was 70.3%)\n  ` +
      failures.join('\n  ')
  );
});

test('matching recall does not regress', () => {
  const { tp, fn, failures } = evaluate();
  const recall = tp / (tp + fn || 1);
  assert.ok(
    recall >= 0.95,
    `recall ${(100 * recall).toFixed(1)}%\n  ` + failures.join('\n  ')
  );
});

test('an organisation name can never fill a field measured in days', () => {
  // The type gate, stated directly. This is the defect that corrupted real data.
  const match = FieldMatch.matchField(
    { label: 'Current Company Notice Period (number of days)', tag: 'input', type: 'number' },
    { currentCompany: 'DP World', noticePeriod: '30' }
  );
  assert.notEqual(match && match.key, 'currentCompany');
});

test('a field belonging to someone else is never filled', () => {
  for (const label of ["Referrer's email", "Manager's phone number", 'Emergency contact name']) {
    const match = FieldMatch.matchField({ label, tag: 'input' }, corpus.profile);
    assert.equal(match, null, `"${label}" must not be filled`);
  }
});

test('password fields are refused regardless of label', () => {
  const match = FieldMatch.matchField(
    { label: 'Email', tag: 'input', type: 'password' },
    corpus.profile
  );
  assert.equal(match, null);
});

test('form field types are inferred from the element and the label', () => {
  const t = (f) => FieldMatch.inferFormFieldType(f);
  assert.equal(t({ tag: 'input', type: 'email' }), 'email');
  assert.equal(t({ tag: 'textarea' }), 'longtext');
  assert.equal(t({ tag: 'select' }), 'enum');
  assert.equal(t({ tag: 'input', type: 'number', label: 'Notice period (number of days)' }), 'duration');
  assert.equal(t({ tag: 'input', type: 'number', label: 'Years of experience' }), 'number');
});
