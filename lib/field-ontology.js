/* eslint-disable no-var */
/**
 * lib/field-ontology.js — the canonical field vocabulary, as data.
 *
 * Deliberately data, not logic: matching rules that live as regexes scattered
 * through a 7,000-line content script cannot be reviewed, tested or tuned. Every
 * entry declares
 *   type  — what KIND of value it holds, so a type gate can reject impossible
 *           matches outright (an organisation name can never answer a field
 *           measured in days).
 *   head  — the noun that must be present for this field to be a candidate.
 *   veto  — terms that disqualify it even when `head` matches. This is the piece
 *           the old regex table had no way to express, and its absence is why
 *           "Current Company Notice Period" was filled with an employer name.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.FieldOntology = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Two distinct classes, because they warrant different force.
  //
  // THIRD_PARTY: the answer belongs to somebody other than the candidate.
  // Nothing from the profile can be correct, so this is a hard veto.
  var THIRD_PARTY = [
    /\b(referr?er|recruiter|manager|supervisor|reference|emergency|next of kin|spouse|guardian|colleague)\b/i,
    /\b(?!your\b)[a-z]+'s\b/i
  ];

  // OPEN_QUESTION: free-form prose, or a hypothetical rather than a stored fact.
  // Soft — it only blocks when the match is otherwise ambiguous or free-text.
  var OPEN_QUESTION = [
    /\b(why|describe|explain|tell us|how did you|in your own words)\b/i,
    /\bwhat\s+(is|are|was|would|makes)\b/i,
    /\bwould you\b/i,
    /\bprefer(red|ence)?\b/i
  ];

  // Kept for callers that want the union.
  var NOT_ABOUT_YOU = THIRD_PARTY.concat(OPEN_QUESTION);

  var FIELDS = [
    { id: 'firstName', type: 'text', head: /\b(first\s*name|given\s*name|forename)\b/i },
    { id: 'lastName', type: 'text', head: /\b(last\s*name|surname|family\s*name)\b/i },
    { id: 'email', type: 'email', head: /\be-?mail\b/i },
    { id: 'phone', type: 'phone', head: /\b(phone|mobile|cell|telephone|contact\s*number)\b/i },

    { id: 'linkedin', type: 'url', head: /\blinked\s*in\b/i },
    { id: 'github', type: 'url', head: /\bgit\s*hub\b/i },
    {
      id: 'portfolio', type: 'url',
      head: /\b(portfolio|personal\s*(web)?site|website|personal\s*url)\b/i,
      // "Company website" belongs to the employer, not the candidate.
      veto: /\b(company|employer|organi[sz]ation|current\s*employer)\b/i
    },

    { id: 'address', type: 'text', head: /\b(street|address\s*line\s*1|address)\b/i, veto: /\b(email|e-mail|ip)\b/i },
    { id: 'city', type: 'text', head: /\bcity\b|\btown\b/i, veto: /\b(relocat\w*|willing|desired|target|birth\w*|hometown)\b/i },
    { id: 'state', type: 'enum:state', head: /\b(state|province|region)\b/i, veto: /\b(statement|united states)\b/i },
    { id: 'country', type: 'enum:country', head: /\b(country|nation)\b/i, veto: /\b(citizenship|birth)\b/i },
    { id: 'zipcode', type: 'text', head: /\b(zip|postal\s*code|post\s*code|postcode)\b/i },

    {
      id: 'currentCompany', type: 'org',
      head: /\b(company|employer|organi[sz]ation)\b/i,
      // Every one of these appeared as a real false positive.
      veto: /\b(notice|period|days?|size|culture|website|url|previous|former|why|reason|prefer|type|industry|values?)\b/i
    },
    {
      id: 'currentTitle', type: 'jobtitle',
      head: /\b(job\s*title|current\s*title|position|role|designation)\b/i,
      veto: /\b(desired|preferr?\w*|apply\w*|applic\w*|interested|future)\b/i
    },
    {
      id: 'totalYearsExperience', type: 'number',
      head: /\b(years?\s*(of\s*)?experience|experience\s*\(years\)|total\s*experience)\b/i,
      // "years of experience WITH React" is skill-scoped, not the candidate's total.
      veto: /\bwith\b|\bin\s+(react|java|python|node|aws|kubernetes|sql)\b|\bspecific\b/i
    },
    {
      id: 'noticePeriod', type: 'duration',
      head: /\bnotice\s*period\b|\bnotice\b(?=.*\bdays?\b)|\bavailability\s*\(days\)/i
    },
    { id: 'salary', type: 'money', head: /\b(salary|compensation|expected\s*pay|desired\s*pay|ctc)\b/i },
    { id: 'summary', type: 'longtext', head: /\b(summary|about\s*(you|me|yourself)|bio|profile\s*summary|objective)\b/i }
  ];

  // Which profile types may legally fill which form-field types.
  // A blank cell means "never" — this is the gate that stops an org name landing
  // in a numeric field, which no amount of string-similarity tuning can prevent.
  var COMPATIBLE = {
    text: ['text', 'longtext', 'enum'],
    email: ['email', 'text'],
    phone: ['phone', 'text'],
    url: ['url', 'text'],
    org: ['text', 'org'],
    jobtitle: ['text', 'jobtitle'],
    number: ['number', 'text', 'enum', 'duration'],
    duration: ['number', 'duration', 'text', 'enum'],
    money: ['number', 'money', 'text'],
    longtext: ['longtext', 'text'],
    'enum:state': ['enum', 'text'],
    'enum:country': ['enum', 'text']
  };

  return {
    FIELDS: FIELDS,
    THIRD_PARTY: THIRD_PARTY,
    OPEN_QUESTION: OPEN_QUESTION,
    NOT_ABOUT_YOU: NOT_ABOUT_YOU,
    COMPATIBLE: COMPATIBLE
  };
});
