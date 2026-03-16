/* eslint-disable no-var */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.FieldUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SENSITIVE_RE = /ssn|social.?sec|\bsin\b|tax.?id|\bein\b|passport|bank.?acc|routing|\bcvv\b|credit.?card|debit|secret/i;

  function isUnstableId(str) {
    if (!str) return false;
    var s = String(str).trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) // UUID
      || /^\d+$/.test(s)                          // purely numeric
      || /^[a-z0-9]{20,}$/i.test(s);              // long opaque hash (no separators)
  }

  function cleanLabelText(text) {
    if (!text) return '';
    return String(text).replace(/\*/g, '').trim();
  }

  function selectFieldKey(candidates) {
    if (!candidates) return null;
    var labelCandidates = [
      candidates.labelledByText,
      candidates.describedByText,
      candidates.labelForText,
      candidates.parentLabelText,
      candidates.prevLabelText,
      candidates.headingText,
      candidates.siteLabel,
      candidates.dataAutomationLabel,
      candidates.ancestorLabelText,
      candidates.dataLabel
    ];
    for (var i = 0; i < labelCandidates.length; i++) {
      var label = cleanLabelText(labelCandidates[i]);
      if (label) return label;
    }

    var attrCandidates = [
      candidates.name,
      candidates.dataField,
      candidates.id,
      candidates.ariaLabel,
      candidates.placeholder,
      candidates.dataAutomationId,
      candidates.dataQa,
      candidates.dataTest,
      candidates.dataName
    ];
    for (var j = 0; j < attrCandidates.length; j++) {
      var c = attrCandidates[j];
      if (!c) continue;
      var value = String(c).trim();
      if (!value) continue;
      if (isUnstableId(value)) continue;
      return value;
    }
    return null;
  }

  function isSensitiveKey(info) {
    if (!info) return false;
    var key = info.key || '';
    var label = info.label || '';
    return SENSITIVE_RE.test(String(key)) || SENSITIVE_RE.test(String(label));
  }

  return {
    isUnstableId: isUnstableId,
    cleanLabelText: cleanLabelText,
    selectFieldKey: selectFieldKey,
    isSensitiveKey: isSensitiveKey,
  };
});
