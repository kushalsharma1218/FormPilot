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

  // Is there an other-entity or other-instance word outside [headStart, headEnd)?
  // An entity explicitly marked as the candidate's own ("current company") does
  // not count — the notice period at YOUR current company is still yours.
  function qualifiedByOther(label, headStart, headEnd) {
    var patterns = [ontology.OTHER_ENTITY, ontology.OTHER_INSTANCE];
    for (var i = 0; i < patterns.length; i++) {
      var re = new RegExp(patterns[i].source, 'gi');
      var hit;
      while ((hit = re.exec(label)) !== null) {
        var start = hit.index;
        var end = start + hit[0].length;
        if (start >= headStart && end <= headEnd) continue;       // it IS the head
        if (ontology.OWN_ENTITY.test(label.slice(0, start))) continue; // "current company"
        return true;
      }
    }
    return false;
  }

  // Every ontology head that matches, so head-finality can be judged across all
  // candidates rather than per candidate.
  function headPositions(label) {
    var positions = [];
    for (var i = 0; i < ontology.FIELDS.length; i++) {
      var hit = ontology.FIELDS[i].head.exec(label);
      if (hit) positions.push({ id: ontology.FIELDS[i].id, index: hit.index });
    }
    return positions;
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
    if (ontology.POSSESSIVE_OF.test(label)) return null;

    // English compounds are head-final, so in "Company email" the subject is the
    // email and "Company" is a modifier. A candidate whose head is an entity noun
    // sitting before a later head is therefore not the subject at all.
    var heads = headPositions(label);
    var lastHeadIndex = heads.reduce(function (max, h) { return Math.max(max, h.index); }, -1);

    var openQuestion = isOpenQuestion(label);
    var scored = [];

    for (var i = 0; i < ontology.FIELDS.length; i++) {
      var entry = ontology.FIELDS[i];
      if (profile[entry.id] === undefined || profile[entry.id] === '') continue;
      if (!typeAllows(entry.type, formType)) continue;
      if (entry.veto && entry.veto.test(label)) continue;

      var m = entry.head.exec(label);
      if (!m) continue;

      // Positional qualifier check: a word naming another entity, or another
      // instance, that sits OUTSIDE the matched head means the value is not the
      // candidate's own. Done relative to the head rather than as a blanket veto,
      // because "company" is legitimately the head of currentCompany.
      if (qualifiedByOther(label, m.index, m.index + m[0].length)) continue;

      var headIsEntity = ontology.OTHER_ENTITY.test(m[0]);
      if (headIsEntity && m.index < lastHeadIndex) continue; // a modifier, not the subject

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
