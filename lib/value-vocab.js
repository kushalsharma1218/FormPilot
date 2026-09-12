/* eslint-disable no-var */
/**
 * lib/value-vocab.js — canonical vocabularies for dropdown values.
 *
 * The problem this solves: every job portal spells the same answer differently.
 * "United States" / "USA" / "US" / "United States of America" are one concept and
 * four strings, so string-similarity matching is fighting the wrong battle. Here
 * each concept gets a CODE, every surface form resolves to that code, and two
 * dropdowns match when their codes are equal — an exact join, not a guess.
 *
 * Codes are namespaced by type, which also removes a class of collision the old
 * flat map could not express: "CA" is Canada under `country` and California
 * under `state`, and nothing outside a type could tell them apart.
 *
 * Ranges ("5-7 years", "More than 10") are handled separately, by parsing to an
 * interval and testing containment — these bands are extremely common on ATS
 * forms and no amount of token matching resolves them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.ValueVocab = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function norm(str) {
    return String(str == null ? '' : str)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // code -> surface forms. Deliberately small and high-traffic; grow it from the
  // dropdowns real portals actually use rather than trying to be exhaustive.
  var VOCAB = {
    'enum:yesno': {
      YES: ['yes', 'y', 'true', '1', 'i am', 'i do', 'authorized', 'authorised', 'eligible', 'agree', 'agreed', 'confirm', 'si', 'oui'],
      NO: ['no', 'n', 'false', '0', 'i am not', 'i do not', 'not authorized', 'not authorised', 'unauthorized', 'ineligible', 'disagree', 'decline', 'non']
    },
    'enum:country': {
      US: ['united states', 'usa', 'us', 'u s', 'u s a', 'united states of america', 'america'],
      GB: ['united kingdom', 'uk', 'great britain', 'britain', 'england'],
      IN: ['india', 'republic of india'],
      CA: ['canada'],
      AE: ['united arab emirates', 'uae', 'emirates'],
      AU: ['australia'],
      DE: ['germany', 'deutschland'],
      SG: ['singapore'],
      IE: ['ireland'],
      NL: ['netherlands', 'holland']
    },
    'enum:education': {
      HIGH_SCHOOL: ['high school', 'high school diploma', 'secondary', 'ged', 'matriculation', '12th'],
      ASSOCIATE: ['associate', 'associates', 'associate degree', 'associates degree', 'diploma'],
      BACHELOR: ['bachelor', 'bachelors', 'bachelor s degree', 'bachelors degree', 'ba', 'bs', 'bsc', 'b tech', 'btech', 'b e', 'be', 'undergraduate', 'bachelor s'],
      MASTER: ['master', 'masters', 'master s degree', 'masters degree', 'ma', 'ms', 'msc', 'm tech', 'mtech', 'mba', 'postgraduate', 'master s'],
      DOCTORATE: ['doctorate', 'phd', 'ph d', 'doctoral', 'dphil']
    },
    'enum:workmode': {
      REMOTE: ['remote', 'work from home', 'wfh', 'fully remote', 'telecommute'],
      HYBRID: ['hybrid', 'flexible', 'partially remote'],
      ONSITE: ['onsite', 'on site', 'in office', 'in person', 'office based']
    },
    'enum:gender': {
      MALE: ['male', 'm', 'man'],
      FEMALE: ['female', 'f', 'woman'],
      NONBINARY: ['non binary', 'nonbinary', 'genderqueer'],
      DECLINE: ['prefer not to say', 'decline to self identify', 'i do not wish to answer', 'prefer not to disclose', 'not specified']
    }
  };

  // Built once: normalised surface form -> code, per type, plus the forms ordered
  // longest-first. Order matters for the prefix pass below: "i am not authorized"
  // must resolve to NO via "i am not", never to YES via the shorter "i am".
  var INDEX = {};
  var PREFIXES = {};
  Object.keys(VOCAB).forEach(function (type) {
    INDEX[type] = {};
    Object.keys(VOCAB[type]).forEach(function (code) {
      VOCAB[type][code].forEach(function (form) {
        INDEX[type][norm(form)] = code;
      });
    });
    PREFIXES[type] = Object.keys(INDEX[type]).sort(function (a, b) {
      return b.length - a.length;
    });
  });

  /**
   * Resolve one option's text (and value attribute) to a canonical code.
   * Exact-on-normalised only — a fuzzy resolver here would reintroduce exactly
   * the sloppiness the codes exist to remove.
   */
  function resolveToCode(type, text, value) {
    var table = INDEX[type];
    if (!table) return null;
    var candidates = [norm(text), norm(value)];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && table[candidates[i]]) return table[candidates[i]];
    }
    // Leading-phrase match: "Yes, I am authorized to work in the US" -> YES.
    // Longest form first, so the most specific prefix wins.
    var first = candidates[0];
    if (first) {
      var forms = PREFIXES[type];
      for (var k = 0; k < forms.length; k++) {
        var form = forms[k];
        if (form.length >= 2 && (first === form || first.indexOf(form + ' ') === 0)) {
          return table[form];
        }
      }
    }
    return null;
  }

  // ── Numeric ranges ────────────────────────────────────────────
  // "0-2 years", "3 to 5", "More than 10", "Less than 1", "10+", "5"
  function parseRange(text) {
    var t = String(text == null ? '' : text).toLowerCase().replace(/,/g, '');
    var m;

    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|\bto\b)\s*(\d+(?:\.\d+)?)/))) {
      return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
    }
    if ((m = t.match(/(?:more than|greater than|over|at least|minimum(?: of)?|\bmin\b)\s*(\d+(?:\.\d+)?)/))) {
      return { min: parseFloat(m[1]), max: Infinity };
    }
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*\+/))) {
      return { min: parseFloat(m[1]), max: Infinity };
    }
    if ((m = t.match(/(?:less than|under|fewer than|below|up to|at most|maximum(?: of)?|\bmax\b)\s*(\d+(?:\.\d+)?)/))) {
      return { min: 0, max: parseFloat(m[1]) };
    }
    if ((m = t.match(/^\D*(\d+(?:\.\d+)?)\D*$/))) {
      var n = parseFloat(m[1]);
      return { min: n, max: n };
    }
    return null;
  }

  function rangeContains(range, value) {
    var n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
    if (!range || !isFinite(n)) return false;
    return n >= range.min && n <= range.max;
  }

  /**
   * Pick the option that means the same thing as `saved`.
   *
   * Order matters: an exact code join is trusted, a numeric interval is trusted,
   * and anything else is handed back as null so the caller can fall through to
   * fuzzy token scoring. Returning null is a legitimate answer — no option may
   * genuinely mean what the user stored.
   *
   * @param {string} valueType  e.g. 'enum:country', 'number'
   * @param {string} saved      the user's stored answer
   * @param {Array<{text:string,value:string}>} options
   * @returns {{option:object, via:string}|null}
   */
  function chooseOption(valueType, saved, options) {
    if (!saved || !Array.isArray(options) || !options.length) return null;

    if (INDEX[valueType]) {
      var savedCode = resolveToCode(valueType, saved, saved);
      if (savedCode) {
        for (var i = 0; i < options.length; i++) {
          var code = resolveToCode(valueType, options[i].text, options[i].value);
          if (code && code === savedCode) return { option: options[i], via: 'code:' + code };
        }
      }
      return null;
    }

    if (valueType === 'number' || valueType === 'duration' || valueType === 'money') {
      var n = parseFloat(String(saved).replace(/[^0-9.]/g, ''));
      if (!isFinite(n)) return null;
      var exact = null;
      var banded = null;
      for (var j = 0; j < options.length; j++) {
        var range = parseRange(options[j].text) || parseRange(options[j].value);
        if (!range || !rangeContains(range, n)) continue;
        // A band that pins the exact value beats an open-ended one.
        if (range.min === range.max) { exact = exact || { option: options[j], via: 'exact:' + n }; }
        else if (!banded) { banded = { option: options[j], via: 'range:' + range.min + '-' + range.max }; }
      }
      return exact || banded;
    }

    return null;
  }

  return {
    VOCAB: VOCAB,
    chooseOption: chooseOption,
    resolveToCode: resolveToCode,
    parseRange: parseRange,
    rangeContains: rangeContains,
    normalize: norm
  };
});
