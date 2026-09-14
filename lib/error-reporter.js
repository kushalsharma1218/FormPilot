/* eslint-disable no-var */
/**
 * lib/error-reporter.js — captures uncaught errors from every extension surface.
 *
 * Nothing captured crashes before this: logEvent() had to be called by hand at
 * chosen points, so the failures that actually mattered — a SyntaxError that
 * killed the service worker before a line ran, a ReferenceError in a listbox
 * fill path — were invisible outside devtools.
 *
 * Two things this must get right, because the extension holds the user's full
 * profile and their auth tokens:
 *
 *   SCRUBBING   error messages and stacks routinely contain the values that
 *               caused them. Everything is redacted before it leaves the page.
 *   FINGERPRINT identical crashes must group, or a loop firing 400 times a
 *               minute buries everything else.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.ErrorReporter = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REDACTIONS = [
    [/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'],
    [/\b(?:\+?\d[\s().-]?){7,}\d\b/g, '<phone>'],
    [/\b(?:gsk|sk|ghp|pk)_[A-Za-z0-9_-]{10,}\b/g, '<key>'],
    [/\bAIza[A-Za-z0-9_-]{10,}\b/g, '<key>'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>'],
    // Query strings routinely carry tokens and applicant ids.
    [/\?[^\s'"]+/g, '?<query>']
  ];

  // Values from the user's own profile, registered at install time so that a
  // message like 'cannot set "Kushal" on null' does not leak a real name.
  var ownValues = [];

  function escapeRe(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function scrub(text) {
    var out = String(text == null ? '' : text);
    for (var i = 0; i < REDACTIONS.length; i++) {
      out = out.replace(REDACTIONS[i][0], REDACTIONS[i][1]);
    }
    for (var j = 0; j < ownValues.length; j++) {
      out = out.replace(ownValues[j], '<profile>');
    }
    return out.length > 2000 ? out.slice(0, 2000) + '…' : out;
  }

  function registerOwnValues(profile) {
    ownValues = [];
    if (!profile) return;
    Object.keys(profile).forEach(function (k) {
      var v = profile[k];
      // Short values produce noisy false matches ("5", "IN"); skip them.
      if (typeof v === 'string' && v.length >= 4) {
        ownValues.push(new RegExp(escapeRe(v), 'gi'));
      }
    });
  }

  // Stable id from the message plus the first app frame, so repeats of one bug
  // collapse into a single entry with a count.
  function fingerprint(message, stack) {
    var firstFrame = '';
    var lines = String(stack || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/(\w[\w.-]*\.js):(\d+)/);
      if (m) { firstFrame = m[1] + ':' + m[2]; break; }
    }
    var basis = String(message || '').replace(/\d+/g, 'N') + '|' + firstFrame;
    var hash = 0;
    for (var c = 0; c < basis.length; c++) {
      hash = ((hash << 5) - hash + basis.charCodeAt(c)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function describe(surface, message, stack, extra) {
    var msg = scrub(message);
    var stk = scrub(stack);
    return Object.assign({
      kind: 'error',
      surface: surface,
      message: msg,
      stack: stk,
      fingerprint: fingerprint(msg, stk),
      at: new Date().toISOString()
    }, extra || {});
  }

  function send(record) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({ type: 'LOG_EVENT', event: record })["catch"](function () { });
    } catch (_) { /* context invalidated mid-navigation */ }
  }

  var installed = false;

  /**
   * @param {string} surface 'content' | 'background' | 'popup' | 'dashboard'
   * @param {object} [opts]  { report } to override delivery (used by tests)
   */
  function install(surface, opts) {
    if (installed) return;
    installed = true;
    var deliver = (opts && opts.report) || send;
    var scope = typeof self !== 'undefined' ? self : globalThis;
    if (!scope || typeof scope.addEventListener !== 'function') {
      installed = false; // nothing attached; let a later call retry
      return false;
    }

    scope.addEventListener('error', function (evt) {
      // Resource load failures have no .error and are not our bugs.
      if (!evt || (!evt.error && !evt.message)) return;
      deliver(describe(surface, evt.message || String(evt.error), evt.error && evt.error.stack, {
        source: evt.filename ? scrub(evt.filename) : undefined,
        line: evt.lineno
      }));
    });

    scope.addEventListener('unhandledrejection', function (evt) {
      var reason = evt && evt.reason;
      deliver(describe(surface, (reason && reason.message) || String(reason), reason && reason.stack, {
        rejected: true
      }));
    });

    return true;
  }

  return {
    install: install,
    scrub: scrub,
    fingerprint: fingerprint,
    describe: describe,
    registerOwnValues: registerOwnValues
  };
});
