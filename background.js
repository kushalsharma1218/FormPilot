// background.js — Service Worker (v2.0 with AI)

importScripts('ai-service.js');

const STORAGE_KEY = 'autofill_data';
const GLOBAL_STORAGE_KEY = 'global_profile_data';

async function getData() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || { sites: {}, hostnameMappings: {} };
}

async function saveData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

async function getGlobalProfile() {
  const result = await chrome.storage.local.get(GLOBAL_STORAGE_KEY);
  return result[GLOBAL_STORAGE_KEY] || {};
}

async function saveGlobalProfile(profile) {
  await chrome.storage.local.set({ [GLOBAL_STORAGE_KEY]: profile });
}

// Resolve the effective site key for a hostname (custom or plain hostname)
function resolveSiteKey(data, hostname) {
  return (data.hostnameMappings || {})[hostname] || hostname;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // ── Original autofill handlers ───────────────────────────────
      if (msg.type === 'GET_SITE_KEY' || msg.type === 'GET_SITE_DATA' ||
        msg.type === 'SET_ENABLED' || msg.type === 'SAVE_FIELDS' ||
        msg.type === 'DISABLE_SITE' || msg.type === 'CLEAR_SITE' ||
        msg.type === 'RENAME_SITE' || msg.type === 'GET_ALL_DATA' ||
        msg.type === 'GET_GLOBAL_PROFILE' || msg.type === 'SAVE_GLOBAL_PROFILE') {

        const data = await getData();
        if (!data.hostnameMappings) data.hostnameMappings = {};

        if (msg.type === 'GET_SITE_KEY') {
          sendResponse({ siteKey: resolveSiteKey(data, msg.hostname) });

        } else if (msg.type === 'GET_SITE_DATA') {
          const siteKey = resolveSiteKey(data, msg.hostname);
          const site = data.sites[siteKey] || { enabled: false, fields: {} };
          sendResponse({ site, siteKey });

        } else if (msg.type === 'SET_ENABLED') {
          const siteKey = resolveSiteKey(data, msg.hostname);
          if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {} };
          data.sites[siteKey].enabled = msg.enabled;
          if (msg.clearDisabled) data.sites[siteKey].disabled = false;
          await saveData(data);
          sendResponse({ ok: true });

        } else if (msg.type === 'SAVE_FIELDS') {
          const siteKey = resolveSiteKey(data, msg.hostname);
          if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {} };
          data.sites[siteKey].fields = Object.assign({}, data.sites[siteKey].fields, msg.fields);
          await saveData(data);
          sendResponse({ ok: true });

        } else if (msg.type === 'DISABLE_SITE') {
          const siteKey = resolveSiteKey(data, msg.hostname);
          if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {} };
          data.sites[siteKey].disabled = true;
          await saveData(data);
          sendResponse({ ok: true });

        } else if (msg.type === 'CLEAR_SITE') {
          const siteKey = resolveSiteKey(data, msg.hostname);
          if (data.sites[siteKey]) data.sites[siteKey].fields = {};
          await saveData(data);
          sendResponse({ ok: true });

        } else if (msg.type === 'RENAME_SITE') {
          const oldKey = resolveSiteKey(data, msg.hostname);
          const newKey = msg.newKey.trim();
          if (!newKey || newKey === oldKey) { sendResponse({ ok: false }); return; }
          if (data.sites[oldKey]) {
            data.sites[newKey] = data.sites[oldKey];
            delete data.sites[oldKey];
          }
          data.hostnameMappings[msg.hostname] = newKey;
          await saveData(data);
          sendResponse({ ok: true, newKey });

        } else if (msg.type === 'GET_ALL_DATA') {
          sendResponse({ data });

        } else if (msg.type === 'GET_GLOBAL_PROFILE') {
          const profile = await getGlobalProfile();
          sendResponse({ profile });

        } else if (msg.type === 'SAVE_GLOBAL_PROFILE') {
          await saveGlobalProfile(msg.profile);
          sendResponse({ ok: true });
        }
        return;
      }

      // ── AI Settings ─────────────────────────────────────────────
      if (msg.type === 'AI_GET_SETTINGS') {
        const settings = await getAiSettings();
        sendResponse({ settings });
        return;
      }
      if (msg.type === 'AI_SAVE_SETTINGS') {
        await saveAiSettings(msg.settings);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'AI_TEST_CONNECTION') {
        const settings = await getAiSettings();
        if (!settings.apiKey) { sendResponse({ ok: false, error: 'No API key set' }); return; }
        // Quick test call
        const tempSettings = { ...settings, enabled: true };
        await saveAiSettings(tempSettings);
        try {
          await callAI('Reply with exactly: OK', { temperature: 0, maxTokens: 10 });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        } finally {
          await saveAiSettings(settings); // restore original
        }
        return;
      }

      // ── Resume Parsing ──────────────────────────────────────────
      if (msg.type === 'AI_PARSE_RESUME') {
        const parsed = await parseResume(msg.text);
        sendResponse({ ok: true, parsed });
        return;
      }

      // ── Job Match Score ─────────────────────────────────────────
      if (msg.type === 'AI_SCORE_MATCH') {
        const profile = await getGlobalProfile();
        const score = await scoreJobMatch(msg.jobDescription, profile);
        sendResponse({ ok: true, score });
        return;
      }

      // ── Cover Letter ───────────────────────────────────────────
      if (msg.type === 'AI_COVER_LETTER') {
        const profile = await getGlobalProfile();
        const letter = await generateCoverLetter(msg.jobDescription, profile, msg.tone || 'professional');
        sendResponse({ ok: true, letter });
        return;
      }

      // ── Resume Tailoring ───────────────────────────────────────
      if (msg.type === 'AI_TAILOR_RESUME') {
        const profile = await getGlobalProfile();
        const tailored = await tailorResume(msg.jobDescription, profile);
        sendResponse({ ok: true, tailored });
        return;
      }

      // ── Answer Generator ───────────────────────────────────────
      if (msg.type === 'AI_GENERATE_ANSWER') {
        const profile = await getGlobalProfile();
        const answer = await generateAnswer(msg.question, msg.jobContext || '', profile);
        sendResponse({ ok: true, answer });
        return;
      }

      // ── Smart Field Matching ───────────────────────────────────
      if (msg.type === 'AI_MATCH_FIELDS') {
        const profile = await getGlobalProfile();
        const profileFields = Object.keys(profile);
        const mapping = await matchFields(msg.fieldLabels, profileFields);
        sendResponse({ ok: true, mapping });
        return;
      }

      // ── Extract Job Info ───────────────────────────────────────
      if (msg.type === 'AI_EXTRACT_JOB') {
        const info = await extractJobInfo(msg.pageContent);
        sendResponse({ ok: true, info });
        return;
      }

      // ── Interview Prep ─────────────────────────────────────────
      if (msg.type === 'AI_INTERVIEW_PREP') {
        const profile = await getGlobalProfile();
        const prep = await generateInterviewQuestions(msg.jobDescription, profile);
        sendResponse({ ok: true, prep });
        return;
      }

      // ── Follow-up Email ────────────────────────────────────────
      if (msg.type === 'AI_FOLLOW_UP') {
        const profile = await getGlobalProfile();
        const email = await generateFollowUp(msg.application, profile);
        sendResponse({ ok: true, email });
        return;
      }

      // ── Application Tracker ────────────────────────────────────
      if (msg.type === 'APP_GET_ALL') {
        const apps = await getApplications();
        sendResponse({ apps });
        return;
      }
      if (msg.type === 'APP_ADD') {
        const apps = await addApplication(msg.application);
        sendResponse({ ok: true, apps });
        return;
      }
      if (msg.type === 'APP_UPDATE') {
        const apps = await updateApplication(msg.id, msg.updates);
        sendResponse({ ok: true, apps });
        return;
      }
      if (msg.type === 'APP_DELETE') {
        const apps = await deleteApplication(msg.id);
        sendResponse({ ok: true, apps });
        return;
      }

    } catch (err) {
      console.error('[Job Autofill] Background Error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async
});
