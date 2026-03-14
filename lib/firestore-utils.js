/* eslint-disable no-var */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.FirestoreUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function toFirestoreValue(val) {
    if (val === null || val === undefined) return { nullValue: null };
    if (typeof val === 'boolean') return { booleanValue: val };
    if (typeof val === 'number') {
      if (Number.isInteger(val)) return { integerValue: String(val) };
      return { doubleValue: val };
    }
    if (typeof val === 'string') return { stringValue: val };
    if (Array.isArray(val)) {
      return { arrayValue: { values: val.map(toFirestoreValue) } };
    }
    if (typeof val === 'object') {
      var fields = {};
      Object.entries(val).forEach(function (entry) {
        fields[entry[0]] = toFirestoreValue(entry[1]);
      });
      return { mapValue: { fields: fields } };
    }
    return { stringValue: String(val) };
  }

  function fromFirestoreValue(fv) {
    if (!fv) return null;
    if ('nullValue' in fv) return null;
    if ('booleanValue' in fv) return fv.booleanValue;
    if ('integerValue' in fv) return parseInt(fv.integerValue, 10);
    if ('doubleValue' in fv) return fv.doubleValue;
    if ('stringValue' in fv) return fv.stringValue;
    if ('arrayValue' in fv) {
      return (fv.arrayValue.values || []).map(fromFirestoreValue);
    }
    if ('mapValue' in fv) {
      var obj = {};
      Object.entries(fv.mapValue.fields || {}).forEach(function (entry) {
        obj[entry[0]] = fromFirestoreValue(entry[1]);
      });
      return obj;
    }
    return null;
  }

  function toFirestoreDoc(obj) {
    var fields = {};
    Object.entries(obj || {}).forEach(function (entry) {
      fields[entry[0]] = toFirestoreValue(entry[1]);
    });
    return { fields: fields };
  }

  function fromFirestoreDoc(doc) {
    if (!doc || !doc.fields) return {};
    var obj = {};
    Object.entries(doc.fields).forEach(function (entry) {
      obj[entry[0]] = fromFirestoreValue(entry[1]);
    });
    return obj;
  }

  return {
    toFirestoreValue: toFirestoreValue,
    fromFirestoreValue: fromFirestoreValue,
    toFirestoreDoc: toFirestoreDoc,
    fromFirestoreDoc: fromFirestoreDoc,
  };
});
