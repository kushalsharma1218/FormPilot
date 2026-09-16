const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const CONTENT_PATH = path.join(__dirname, '..', 'content.js');
const FIELD_UTILS = require(path.join(__dirname, '..', 'lib', 'field-utils.js'));
const FIELD_ONTOLOGY = require(path.join(__dirname, '..', 'lib', 'field-ontology.js'));
const FIELD_MATCH = require(path.join(__dirname, '..', 'lib', 'field-match.js'));
const VALUE_VOCAB = require(path.join(__dirname, '..', 'lib', 'value-vocab.js'));

function readHtml(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'dev', name), 'utf8');
}

function setupDom(html, url, profile, opts = {}) {
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: 'usable',
  });

  const win = dom.window;
  const doc = win.document;

  // Make elements "visible" in jsdom
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20 };
  };

  if (!('innerText' in win.HTMLElement.prototype)) {
    Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
      get() { return this.textContent || ''; },
      set(v) { this.textContent = v; },
    });
  }

  win.InputEvent = win.InputEvent || class InputEvent extends win.Event {
    constructor(type, evtOpts) {
      super(type, evtOpts);
      this.data = evtOpts?.data;
    }
  };
  win.PointerEvent = win.PointerEvent || win.Event;
  win.CSS = win.CSS || { escape: s => s };
  doc.execCommand = () => false;
  win.HTMLElement.prototype.scrollIntoView = () => { };

  const siteEnabled = opts.siteEnabled !== undefined ? opts.siteEnabled : true;
  const siteExcluded = opts.siteExcluded || false;
  const signedIn = opts.signedIn !== undefined ? opts.signedIn : true;
  const requireSignIn = opts.requireSignIn || false;

  // Stub chrome APIs
  const messageCounts = Object.create(null);
  const chromeStub = {
    runtime: {
      id: 'test',
      sendMessage: async (msg) => {
        messageCounts[msg.type] = (messageCounts[msg.type] || 0) + 1;
        switch (msg.type) {
          case 'GET_SITE_DATA':
            return {
              site: {
                enabled: siteEnabled,
                disabled: !siteEnabled,
                fields: {},
                mappings: [],
                flags: {}
              },
              siteKey: msg.hostname || 'file'
            };
          case 'GET_GLOBAL_PROFILE':
            return { profile };
          case 'SESSION_GET':
            return { ok: true, fields: {}, flags: {} };
          case 'IS_SITE_EXCLUDED':
            return { excluded: siteExcluded };
          case 'CLOUD_GET_STATUS':
            return { ok: true, loggedIn: signedIn };
          case 'GET_EXT_SETTINGS':
            return { ok: true, settings: { requireSignIn } };
          default:
            return { ok: true };
        }
      },
      onMessage: { addListener: () => { } },
      getURL: (p) => `chrome-extension://test/${p}`,
      openOptionsPage: () => { },
    },
    tabs: {},
    storage: { local: { get: async () => ({}), set: async () => { } } },
  };

  dom.__messageCounts = messageCounts;

  // Expose globals expected by content.js
  global.window = win;
  global.document = doc;
  global.navigator = win.navigator;
  global.location = win.location;
  global.MutationObserver = win.MutationObserver;
  global.InputEvent = win.InputEvent;
  global.PointerEvent = win.PointerEvent;
  global.KeyboardEvent = win.KeyboardEvent;
  global.MouseEvent = win.MouseEvent;
  global.Event = win.Event;
  global.CSS = win.CSS;
  global.HTMLElement = win.HTMLElement;
  global.Node = win.Node;
  global.chrome = chromeStub;
  // Mirror the manifest's content_scripts load order.
  global.JobAutofill = {
    FieldUtils: FIELD_UTILS,
    FieldOntology: FIELD_ONTOLOGY,
    FieldMatch: FIELD_MATCH,
    ValueVocab: VALUE_VOCAB,
  };

  // Unref long timers so tests don't hang
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => {
    const t = realSetTimeout(fn, ms, ...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };

  return dom;
}

function loadContentScript() {
  delete require.cache[require.resolve(CONTENT_PATH)];
  require(CONTENT_PATH);
}

// setupDom() swaps in an unref'd setTimeout for the content script's timers. The
// test's own waits must keep the event loop alive, or Node exits mid-test.
const refSetTimeout = global.setTimeout;
async function wait(ms) {
  return new Promise(r => refSetTimeout(r, ms));
}

test('autofill fills basic job form from global profile', async () => {
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    phone: '555-111-2222',
    linkedin: 'https://linkedin.com/in/kushal',
  };
  const dom = setupDom(readHtml('test-job-form.html'), 'https://example.com/jobs/apply?ja_debug=1', profile);
  loadContentScript();
  await wait(80);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('firstName').value, profile.firstName);
  assert.equal(doc.getElementById('lastName').value, profile.lastName);
  assert.equal(doc.getElementById('email').value, profile.email);
  assert.equal(doc.getElementById('phone').value, profile.phone);
  assert.equal(doc.getElementById('linkedin').value, profile.linkedin);
  dom.window.close();
});

test('dynamic form gets filled after fields appear', async () => {
  const profile = { firstName: 'Kushal', lastName: 'Sharma', email: 'kushal@example.com', phone: '555-111-2222' };
  const dom = setupDom(readHtml('test-job-form-dynamic.html'), 'https://example.com/careers/apply', profile);
  loadContentScript();
  await wait(1600);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('firstName').value, profile.firstName);
  assert.equal(doc.getElementById('lastName').value, profile.lastName);
  assert.equal(doc.getElementById('email').value, profile.email);
  assert.equal(doc.getElementById('phone').value, profile.phone);
  dom.window.close();
});

test('login form should not be autofilled', async () => {
  const profile = { firstName: 'Kushal', lastName: 'Sharma', email: 'kushal@example.com', phone: '555-111-2222' };
  const dom = setupDom(readHtml('test-login-form.html'), 'https://example.com/login', profile);
  loadContentScript();
  await wait(80);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('email').value, '');
  assert.equal(doc.getElementById('password').value, '');
  dom.window.close();
});

test('contact form should not be autofilled', async () => {
  const profile = { firstName: 'Kushal', lastName: 'Sharma', email: 'kushal@example.com', phone: '555-111-2222' };
  const dom = setupDom(readHtml('test-contact-form.html'), 'https://example.com/contact', profile);
  loadContentScript();
  await wait(80);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('name').value, '');
  assert.equal(doc.getElementById('email').value, '');
  dom.window.close();
});

test('dropdowns fill when profile has matching keys', async () => {
  const profile = {
    country: 'United States',
    workMode: 'Remote',
    preferredRole: 'Frontend Engineer',
    // "New York" starts with 'n'; the boolean matcher must not read it as "No"
    // and grab the first N-word option (Nebraska).
    state: 'New York',
    // Padded ATS labels: these have no exact option, only a whole-token match.
    degree: "Bachelor's Degree",
    workAuth: 'Yes',
    // Traps: "male" is a substring of "Female", and nothing here matches "Indeed".
    gender: 'Male',
    heardFrom: 'Indeed',
  };
  const dom = setupDom(readHtml('test-dropdowns.html'), 'https://example.com/jobs/apply', profile);
  loadContentScript();
  await wait(120);

  const doc = dom.window.document;
  const country = doc.getElementById('country');
  const workMode = doc.getElementById('workMode');
  assert.equal(country.options[country.selectedIndex].text.trim(), 'United States');
  assert.equal(workMode.options[workMode.selectedIndex].text.trim(), 'Remote');
  const state = doc.getElementById('state');
  assert.equal(state.options[state.selectedIndex].text.trim(), 'New York');

  // Near-matches must fill: previously every non-exact option scored 0.85 against
  // a 0.92 threshold, so anything but a literal match silently did nothing.
  const degree = doc.getElementById('degree');
  assert.equal(degree.options[degree.selectedIndex].text.trim(), "Bachelor's Degree (BA/BS)");
  const workAuth = doc.getElementById('workAuth');
  assert.equal(workAuth.options[workAuth.selectedIndex].text.trim(), 'Yes, I am authorized to work in the US');

  // ...but a substring collision must not. "Male" is inside "Female"; if the
  // threshold is ever lowered without keeping token-aware scoring, this breaks.
  const gender = doc.getElementById('gender');
  assert.equal(gender.value, '', 'must not pick "Female" for "Male"');
  const heardFrom = doc.getElementById('heardFrom');
  assert.equal(heardFrom.value, '', 'must not guess an unrelated option');
  dom.window.close();
});

test('advanced job form fills and respects sensitive fields', async () => {
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    phone: '555-111-2222',
    linkedin: 'https://linkedin.com/in/kushal',
    portfolio: 'https://kushal.dev',
    currentCompany: 'Acme Corp',
    currentTitle: 'Frontend Engineer',
    summary: 'Builder of reliable UI systems.',
    coverLetter: 'I love building high quality UX for users.',
    country: 'United States',
    workMode: 'Remote',
  };
  const dom = setupDom(readHtml('test-job-form-advanced.html'), 'https://example.com/jobs/apply?ja_debug=1', profile);
  loadContentScript();
  await wait(150);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('firstName').value, profile.firstName);
  assert.equal(doc.getElementById('lastName').value, profile.lastName);
  assert.equal(doc.getElementById('email').value, profile.email);
  assert.equal(doc.getElementById('phone').value, profile.phone);
  assert.equal(doc.getElementById('currentCompany').value, profile.currentCompany);
  assert.equal(doc.getElementById('currentTitle').value, profile.currentTitle);

  const country = doc.getElementById('country');
  assert.equal(country.options[country.selectedIndex].text.trim(), 'United States');
  assert.equal(doc.getElementById('workModeInput').value, profile.workMode);

  // Sensitive field should never be filled
  assert.equal(doc.getElementById('password').value, '');

  // Step 2
  doc.getElementById('next-btn').click();
  await wait(400);
  assert.equal(doc.getElementById('linkedin').value, profile.linkedin);
  assert.equal(doc.getElementById('portfolio').value, profile.portfolio);
  assert.equal(doc.getElementById('coverLetter').innerText.trim(), profile.coverLetter);

  dom.window.close();
});

test('ARIA job form fills combobox, listbox, and contenteditable', async () => {
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    phone: '555-111-2222',
    preferredRole: 'Frontend Engineer',
    country: 'United States',
    summary: 'Design-focused builder.',
  };
  const dom = setupDom(readHtml('test-job-form-aria.html'), 'https://example.com/jobs/apply', profile);
  loadContentScript();
  await wait(200);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('first-name').value, profile.firstName);
  assert.equal(doc.getElementById('last-name').value, profile.lastName);
  assert.equal(doc.getElementById('email-input').value, profile.email);
  assert.equal(doc.getElementById('phone-input').value, profile.phone);
  assert.equal(doc.getElementById('role-input').value, profile.preferredRole);

  const countryOption = Array.from(doc.querySelectorAll('#country-listbox [role="option"]'))
    .find(opt => (opt.getAttribute('data-value') || '').includes('United States'));
  assert.equal(countryOption?.getAttribute('aria-selected'), 'true');

  assert.equal(doc.getElementById('summary-box').innerText.trim(), profile.summary);
  dom.window.close();
});

// ── New tests for disabled and excluded sites ──────────────────

test('disabled site should not autofill and should not inject UI', async () => {
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    phone: '555-111-2222',
  };
  const dom = setupDom(
    readHtml('test-job-form.html'),
    'https://example.com/jobs/apply?ja_debug=1',
    profile,
    { siteEnabled: false }
  );
  loadContentScript();
  await wait(200);

  const doc = dom.window.document;
  // Fields should NOT be filled
  assert.equal(doc.getElementById('firstName').value, '');
  assert.equal(doc.getElementById('lastName').value, '');
  assert.equal(doc.getElementById('email').value, '');
  assert.equal(doc.getElementById('phone').value, '');

  // No FormPilot UI elements should exist
  assert.equal(doc.getElementById('ja-banner'), null);
  assert.equal(doc.getElementById('ja-ai-panel'), null);
  assert.equal(doc.getElementById('ja-job-context-prompt'), null);
  assert.equal(doc.getElementById('ja-save-banner'), null);
  assert.equal(doc.getElementById('ja-coverage-banner'), null);
  dom.window.close();
});

test('excluded site should not autofill and should not inject UI', async () => {
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    phone: '555-111-2222',
  };
  const dom = setupDom(
    readHtml('test-job-form.html'),
    'https://example.com/jobs/apply?ja_debug=1',
    profile,
    { siteExcluded: true }
  );
  loadContentScript();
  await wait(200);

  const doc = dom.window.document;
  // Fields should NOT be filled — the site is excluded
  assert.equal(doc.getElementById('firstName').value, '');
  assert.equal(doc.getElementById('lastName').value, '');
  assert.equal(doc.getElementById('email').value, '');
  assert.equal(doc.getElementById('phone').value, '');
  dom.window.close();
});

test('signed-out user still autofills in local-only mode (default)', async () => {
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    phone: '555-111-2222',
  };
  const dom = setupDom(
    readHtml('test-job-form.html'),
    'https://example.com/jobs/apply?ja_debug=1',
    profile,
    { signedIn: false }
  );
  loadContentScript();
  await wait(200);

  const doc = dom.window.document;
  // requireSignIn defaults to false: local data still fills without an account
  assert.equal(doc.getElementById('firstName').value, 'Kushal');
  assert.equal(doc.getElementById('email').value, 'kushal@example.com');
  dom.window.close();
});

test('signed-out user is blocked when requireSignIn is enabled', async () => {
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    phone: '555-111-2222',
  };
  const dom = setupDom(
    readHtml('test-job-form.html'),
    'https://example.com/jobs/apply?ja_debug=1',
    profile,
    { signedIn: false, requireSignIn: true }
  );
  loadContentScript();
  await wait(200);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('firstName').value, '');
  assert.equal(doc.getElementById('lastName').value, '');
  assert.equal(doc.getElementById('email').value, '');
  assert.equal(doc.getElementById('phone').value, '');
  assert.equal(doc.getElementById('ja-banner'), null);
  dom.window.close();
});

test('re-filling a dropdown settles instead of looping', async () => {
  // A near-matched dropdown used to never register as "already filled", so every
  // re-render refilled it, which fired change, which re-rendered again. The page
  // became unusable while the extension ping-ponged between dropdowns.
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    degree: "Bachelor's Degree",
    workMode: 'Remote',
  };
  const dom = setupDom(readHtml('test-dropdown-rerender.html'), 'https://example.com/jobs/apply', profile);
  loadContentScript();

  // Long enough for several MutationObserver cycles (the debounce is 300ms).
  await wait(2000);

  const doc = dom.window.document;
  const degree = doc.getElementById('degree');
  const workMode = doc.getElementById('workMode');

  // Both should be filled with the padded option...
  assert.equal(degree.options[degree.selectedIndex].text.trim(), "Bachelor's Degree (BA/BS)");
  assert.equal(workMode.options[workMode.selectedIndex].text.trim(), 'Remote (Work from home)');

  // ...and each should have been written once, not on every observer tick.
  const counts = dom.window.__changeCounts;
  assert.ok(counts.degree <= 2, `degree was re-filled ${counts.degree} times (expected <= 2)`);
  assert.ok(counts.workMode <= 2, `workMode was re-filled ${counts.workMode} times (expected <= 2)`);
  dom.window.close();
});

test('custom comboboxes are not re-opened once they show the saved value', async () => {
  // The combobox pass never asked "is this already filled?", and a react-select
  // clears its search input after a pick, so the verify step read it as empty.
  // Every observer pass, step re-apply and verify retry re-opened each menu and
  // re-picked the same option, holding focus while the user waited.
  const profile = {
    firstName: 'Kushal',
    email: 'kushal@example.com',
    degree: "Bachelor's Degree",
    workMode: 'Remote',
  };
  const dom = setupDom(readHtml('test-combobox-rerender.html'), 'https://example.com/jobs/apply', profile);
  loadContentScript();
  await wait(3000);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('degree-display').textContent.trim(), "Bachelor's Degree (BA/BS)");
  assert.equal(doc.getElementById('workMode-trigger').textContent.trim(), 'Remote (Work from home)');

  const counts = dom.window.__comboCounts;
  assert.equal(counts.degreePicks, 1, `degree was picked ${counts.degreePicks} times`);
  assert.equal(counts.workModePicks, 1, `workMode was picked ${counts.workModePicks} times`);
  assert.ok(counts.degreeOpens <= 1, `degree menu was opened ${counts.degreeOpens} times`);
  assert.ok(counts.workModeOpens <= 1, `workMode menu was opened ${counts.workModeOpens} times`);
  // No stray search text left behind in the react-select input.
  assert.equal(doc.getElementById('degree-input').value, '');
  dom.window.close();
});

test('Workday-style dropdowns get picked once and survive re-init and re-render', async () => {
  // Workday options select on mousedown (a bare click() did nothing, so the
  // dropdown stayed empty and was re-opened on every pass), its multiselect search
  // only lists results on Enter, and it re-renders the prompt into a new node —
  // which reset the per-element attempt limit.
  const profile = {
    firstName: 'Kushal',
    country: 'India',
    howDidYouHearAboutUs: 'LinkedIn',
    // Matches the site's language switcher, which must be left alone.
    language: 'Hindi',
  };
  const dom = setupDom(readHtml('test-workday-dropdowns.html'), 'https://example.wd5.myworkdayjobs.com/en-US/global/job/apply', profile);
  loadContentScript();
  await wait(2500);

  // Page keeps poking the URL hash, the way re-init kept firing on Workday.
  for (let i = 0; i < 4; i++) {
    dom.window.location.hash = `#tick${i}`;
    await wait(2200);
  }

  const doc = dom.window.document;
  const wd = dom.window.__wd;
  assert.equal(doc.getElementById('country').textContent.trim(), 'India');
  assert.equal(wd.countryPicks, 1, `country was picked ${wd.countryPicks} times`);
  assert.ok(wd.countryOpens <= 1, `country popup was opened ${wd.countryOpens} times`);
  assert.equal(doc.querySelector('[data-automation-id="selectedItem"]')?.textContent.trim(), 'LinkedIn');
  assert.equal(wd.sourcePicks, 1, `source was picked ${wd.sourcePicks} times`);
  assert.ok(wd.sourceSearches <= 2, `source search ran ${wd.sourceSearches} times`);

  // Site chrome is not part of the application form.
  assert.equal(wd.languageOpens, 0, 'the site language switcher was opened');
  assert.equal(doc.getElementById('site-language').textContent.trim(), 'English');
  assert.equal(wd.localeChanges, 0, 'the site locale select was changed');
  assert.equal(doc.getElementById('localeSelect').value, 'en');
  dom.window.close();
});

test('a continuously re-rendering page does not keep the extension re-scanning', async () => {
  // Both MutationObservers used to rebuild the field caches on *every* mutation
  // rather than once per debounced pass, and the dynamic one had no cap on how
  // many passes it could run. On a React page that re-renders constantly this
  // meant a full DOM re-scan many times a second, for 30s, in every frame —
  // which is what actually made pages unusable.
  const profile = {
    firstName: 'Kushal',
    lastName: 'Sharma',
    email: 'kushal@example.com',
    degree: "Bachelor's Degree",
    workMode: 'Remote',
  };
  const dom = setupDom(readHtml('test-dropdown-rerender.html'), 'https://example.com/jobs/apply', profile);
  loadContentScript();
  await wait(500); // let the initial fill finish

  const doc = dom.window.document;

  // Count DOM scans from here on.
  let scans = 0;
  const realQuerySelectorAll = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (...args) => { scans += 1; return realQuerySelectorAll(...args); };

  // Simulate a page whose own render loop never settles.
  const noise = doc.createElement('div');
  doc.body.appendChild(noise);
  const ticker = setInterval(() => {
    noise.appendChild(doc.createElement('span'));
    if (noise.childNodes.length > 5) noise.removeChild(noise.firstChild);
  }, 40);

  await wait(3000);
  clearInterval(ticker);
  doc.querySelectorAll = realQuerySelectorAll;

  // ~75 mutations happened. Scanning is now capped by MAX_OBSERVER_PASSES, so the
  // scan count must stay far below one-scan-per-mutation.
  assert.ok(scans < 120, `extension re-scanned the DOM ${scans} times during 3s of page churn`);
  dom.window.close();
});

test('rapid SPA navigation does not re-run init for every change', async () => {
  // debouncedInit() is called from hash changes, path changes, auth changes and
  // site-setting messages. On a page whose embed script rewrites the URL these
  // pile up, and every init() is a full document scan. init() is throttled now.
  const profile = { firstName: 'Kushal', lastName: 'Sharma', email: 'kushal@example.com' };
  const dom = setupDom(readHtml('test-job-form.html'), 'https://example.com/jobs/apply', profile);
  loadContentScript();
  await wait(400);

  // GET_SITE_DATA is sent exactly once per init(), so it counts init runs.
  const initsAfterLoad = dom.__messageCounts.GET_SITE_DATA || 0;
  assert.ok(initsAfterLoad >= 1, 'the initial init should have run');

  // Spaced wider than debouncedInit()'s own 600ms debounce, so what is being
  // measured here is the init() throttle rather than the debounce.
  for (let i = 0; i < 5; i++) {
    dom.window.location.hash = `#step${i}`;
    await wait(700);
  }
  await wait(800);

  const extraInits = (dom.__messageCounts.GET_SITE_DATA || 0) - initsAfterLoad;
  assert.ok(extraInits <= 3, `init() re-ran ${extraInits} times for 5 spaced navigations`);
  dom.window.close();
});
