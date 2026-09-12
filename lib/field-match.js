/* eslint-disable no-var */
/**
 * lib/field-match.js — decides which profile field (if any) answers a form field.
 *
 * Replaces a first-match-wins regex race. Three things it does that the old path
 * could not:
 *   1. TYPE GATE      — reject candidates whose value kind cannot answer this
 *                       control at all, before any string scoring.
 *   2. VETO           — let a label's own words disqualify a candidate.
 *   3. HEAD POSITION  — English compound labels are head-final: in "Current
 *                       Company Notice Period" the subject is the Period, not the
 *                       Company. The later head match wins.
 * And it returns null when the winner is not clearly ahead, because a wrong fill
 * is worse than an empty field: auto-learn persists it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./field-ontology.js'));
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.FieldMatch = factory(root.JobAutofill.FieldOntology);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ontology) {
  'use strict';

  var MIN_SCORE = 1;
  var MIN_MARGIN = 0.15; // how far ahead the winner must be to be trusted

  // What kind of value can this control hold? Derived from the element, then
  // refined by the label (a number input asking for "days" is a duration).
  function inferFormFieldType(field) {
    var tag = String(field.tag || 'input').toLowerCase();
    var type = String(field.type || '').toLowerCase();
    var label = String(field.label || '');

    if (type === 'email') return 'email';
    if (type === 'tel') return 'phone';
    if (type === 'url') return 'url';
    if (type === 'password') return 'password';
    if (tag === 'textarea') return 'longtext';
    if (tag === 'select') return 'enum';
    if (type === 'number' || /\bnumber of\b|\bhow many\b|\(days\)|\(years\)/i.test(label)) {
      if (/\bdays?\b|\bnotice\b|\bweeks?\b|\bmonths?\b/i.test(label)) return 'duration';
      return 'number';
    }
    return 'text';
  }

  function typeAllows(profileType, formType) {
    if (formType === 'password') return false; // never, for anything
    var allowed = ontology.COMPATIBLE[profileType];
    if (!allowed) return true; // unknown profile type: fall back to scoring alone
    return allowed.indexOf(formType) !== -1;
  }

  function anyMatch(patterns, label) {
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(label)) return true;
    }
    return false;
  }

  // Hard: the answer is somebody else's ("Referrer's email", "Manager's phone").
  function belongsToSomeoneElse(label) {
    return anyMatch(ontology.THIRD_PARTY, label);
  }

  // Soft: prose or a hypothetical rather than a stored fact.
  function isOpenQuestion(label) {
    return anyMatch(ontology.OPEN_QUESTION, label);
  }

  function notAboutYou(label) {
    return belongsToSomeoneElse(label) || isOpenQuestion(label);
  }

  /**
   * @returns {{key:string, score:number, runnerUp:?string, reason:string}|null}
   */
  function matchField(field, profile) {
    var label = String(field.label || '').trim();
    if (!label) return null;

    var formType = inferFormFieldType(field);
    if (formType === 'password') return null;

    // Nothing we hold can answer somebody else's details.
    if (belongsToSomeoneElse(label)) return null;

    var openQuestion = isOpenQuestion(label);
    var scored = [];

    for (var i = 0; i < ontology.FIELDS.length; i++) {
      var entry = ontology.FIELDS[i];
      if (profile[entry.id] === undefined || profile[entry.id] === '') continue;
      if (!typeAllows(entry.type, formType)) continue;
      if (entry.veto && entry.veto.test(label)) continue;

      var m = entry.head.exec(label);
      if (!m) continue;

      // Head-final bias: a match later in the label is more likely the subject.
      var position = m.index / Math.max(label.length, 1);
      scored.push({ key: entry.id, score: 1 + position, type: entry.type });
    }

    if (!scored.length) return null;
    scored.sort(function (a, b) { return b.score - a.score; });

    var best = scored[0];
    var runnerUp = scored[1];

    // An open-ended question ("why…", "describe…", someone else's details) only
    // gets filled when exactly one candidate survives AND it is a concrete type.
    if (openQuestion) return null;
    if (best.score < MIN_SCORE) return null;
    if (runnerUp && (best.score - runnerUp.score) < MIN_MARGIN) return null;

    return {
      key: best.key,
      score: best.score,
      runnerUp: runnerUp ? runnerUp.key : null,
      reason: 'head@' + best.score.toFixed(2) + ' type=' + best.type + '->' + formType
    };
  }

  return {
    matchField: matchField,
    belongsToSomeoneElse: belongsToSomeoneElse,
    isOpenQuestion: isOpenQuestion,
    inferFormFieldType: inferFormFieldType,
    typeAllows: typeAllows,
    notAboutYou: notAboutYou
  };
});
