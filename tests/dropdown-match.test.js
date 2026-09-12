// Evaluates dropdown option selection against a corpus of real ATS spellings.
//
// The premise: "United States" / "USA" / "US" are one concept and three strings,
// so string similarity is fighting the wrong battle. Resolving both the stored
// answer and each option to a canonical code turns the match into an exact join.
// Numeric bands ("3-5 years") are handled by interval containment, which no
// amount of token matching can do.
//
// Token scoring alone scored 9/17 on this corpus.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Vocab = require('../lib/value-vocab.js');
const { cases } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dropdown-cases.json'), 'utf8')
);

const asOptions = (labels) =>
  labels.filter((t) => !/^select/i.test(t)).map((t) => ({ text: t, value: '' }));

test('dropdown selection matches the concept, not the spelling', () => {
  const failures = [];
  for (const c of cases) {
    const chosen = Vocab.chooseOption(c.valueType, c.saved, asOptions(c.options));
    const got = chosen ? chosen.option.text : null;
    if (got !== c.expect) {
      failures.push(`${c.valueType} "${c.saved}" -> ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n  '));
});

test('a more specific surface form wins over a shorter one', () => {
  // "I am not authorized" must resolve to NO via "i am not", never to YES via
  // the shorter "i am" that happens to prefix it.
  assert.equal(
    Vocab.chooseOption('enum:yesno', 'No', asOptions(['I am authorized to work', 'I am not authorized to work'])).option.text,
    'I am not authorized to work'
  );
});

test('country codes are namespaced, so CA is not ambiguous', () => {
  // Under a flat map "ca" meant Canada AND California. Types keep them apart.
  const country = Vocab.chooseOption('enum:country', 'Canada', asOptions(['Canada', 'United States']));
  assert.equal(country.option.text, 'Canada');
  // No state vocabulary is defined, so a state lookup must decline rather than
  // fall through to the country table.
  assert.equal(Vocab.chooseOption('enum:state', 'California', asOptions(['California', 'Nevada'])), null);
});

test('numeric ranges are parsed, not string-matched', () => {
  const r = Vocab.parseRange;
  assert.deepEqual(r('3-5 years'), { min: 3, max: 5 });
  assert.deepEqual(r('3 to 5'), { min: 3, max: 5 });
  assert.deepEqual(r('10+ years'), { min: 10, max: Infinity });
  assert.deepEqual(r('More than 5 years'), { min: 5, max: Infinity });
  assert.deepEqual(r('Less than 1 year'), { min: 0, max: 1 });
  assert.deepEqual(r('7'), { min: 7, max: 7 });
  assert.equal(r('Select an option'), null);
});

test('a value in no band selects nothing rather than guessing', () => {
  assert.equal(
    Vocab.chooseOption('number', '2', asOptions(['Less than 1 year', 'More than 5 years'])),
    null
  );
});

test('an unknown value type declines, leaving token scoring to decide', () => {
  assert.equal(Vocab.chooseOption('text', 'anything', asOptions(['a', 'b'])), null);
});
