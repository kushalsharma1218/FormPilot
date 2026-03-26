const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const CONTENT_PATH = path.join(__dirname, '..', 'content.js');
const FIELD_UTILS = require(path.join(__dirname, '..', 'lib', 'field-utils.js'));

function readHtml(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'dev', name), 'utf8');
}

function setupDom(html, url, profile) {
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
    constructor(type, opts) {
      super(type, opts);
      this.data = opts?.data;
    }
  };
  win.PointerEvent = win.PointerEvent || win.Event;
  win.CSS = win.CSS || { escape: s => s };
  doc.execCommand = () => false;
  win.HTMLElement.prototype.scrollIntoView = () => {};

  // Stub chrome APIs
  const chromeStub = {
    runtime: {
      id: 'test',
      sendMessage: async (msg) => {
        switch (msg.type) {
          case 'GET_SITE_DATA':
            return { site: { enabled: true, fields: {}, mappings: [], flags: {} }, siteKey: msg.hostname || 'file' };
          case 'GET_GLOBAL_PROFILE':
            return { profile };
          case 'SESSION_GET':
            return { ok: true, fields: {}, flags: {} };
          default:
            return { ok: true };
        }
      },
      onMessage: { addListener: () => {} },
      getURL: (p) => `chrome-extension://test/${p}`,
      openOptionsPage: () => {},
    },
    tabs: {},
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };

  // Expose globals expected by content.js
  global.window = win;
  global.document = doc;
  global.navigator = win.navigator;
  global.location = win.location;
  global.MutationObserver = win.MutationObserver;
  global.InputEvent = win.InputEvent;
  global.PointerEvent = win.PointerEvent;
  global.Event = win.Event;
  global.CSS = win.CSS;
  global.HTMLElement = win.HTMLElement;
  global.Node = win.Node;
  global.chrome = chromeStub;
  global.JobAutofill = { FieldUtils: FIELD_UTILS };

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

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
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
  };
  const dom = setupDom(readHtml('test-dropdowns.html'), 'https://example.com/jobs/apply', profile);
  loadContentScript();
  await wait(120);

  const doc = dom.window.document;
  const country = doc.getElementById('country');
  const workMode = doc.getElementById('workMode');
  assert.equal(country.options[country.selectedIndex].text.trim(), 'United States');
  assert.equal(workMode.options[workMode.selectedIndex].text.trim(), 'Remote');
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
