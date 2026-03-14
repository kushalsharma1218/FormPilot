/* eslint-disable no-var */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.AIUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function extractJSON(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('AI returned empty or non-string response');
    }
    var firstBrace = text.indexOf('{');
    var firstBracket = text.indexOf('[');
    var firstChar = (firstBrace === -1)
      ? firstBracket
      : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));
    var lastBrace = text.lastIndexOf('}');
    var lastBracket = text.lastIndexOf(']');
    var lastChar = Math.max(lastBrace, lastBracket);
    if (firstChar === -1 || lastChar === -1 || lastChar <= firstChar) {
      throw new Error('AI response did not contain valid JSON. Preview: ' + text.substring(0, 200));
    }
    var clean = text.substring(firstChar, lastChar + 1);
    try {
      return JSON.parse(clean);
    } catch (e) {
      throw new Error('AI returned malformed JSON: ' + e.message);
    }
  }

  async function retryWithBackoff(fn, maxAttempts) {
    if (maxAttempts == null) maxAttempts = 3;
    var lastError;
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        var msg = (err && err.message) ? err.message : '';

        // Do not retry hard limits
        if (msg.indexOf('FREE_TIER_EXHAUSTED') !== -1) throw err;

        // Only retry on rate-limit / server errors
        if (
          msg.indexOf('429') !== -1 ||
          Math.max(msg.indexOf('rate'), msg.indexOf('quota')) !== -1 ||
          msg.indexOf('500') !== -1 ||
          msg.indexOf('503') !== -1 ||
          msg.indexOf('overloaded') !== -1
        ) {
          var waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
          console.warn('[AI Utils] Retry ' + (attempt + 1) + '/' + maxAttempts + ' after ' + waitMs + 'ms: ' + msg);
          await new Promise(function (r) { setTimeout(r, waitMs); });
          continue;
        }
        throw err; // non-retryable
      }
    }
    throw lastError;
  }

  return {
    extractJSON: extractJSON,
    retryWithBackoff: retryWithBackoff,
  };
});
