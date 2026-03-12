// ai-service.js — Multi-Provider AI Service for Job Autofill
// Supports: Built-in (Gemini Nano), Gemini API, OpenAI, Anthropic Claude, Groq
// Loaded by background.js via importScripts()

const AI_SETTINGS_KEY = 'ai_settings';
const APPLICATIONS_KEY = 'applications_data';

// ── Settings Management ──────────────────────────────────────
async function getAiSettings() {
  const result = await chrome.storage.local.get(AI_SETTINGS_KEY);
  return result[AI_SETTINGS_KEY] || {
    enabled: true,
    provider: 'built-in',
    apiKey: '',
    model: '',
  };
}

async function saveAiSettings(settings) {
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
}

// ── Provider Registry ─────────────────────────────────────────
const AI_PROVIDERS = {
  'built-in': {
    name: '🧠 Built-in AI (Free — No Key)',
    requiresKey: false,
    models: [
      { id: 'gemini-nano', name: 'Gemini Nano (On-Device)' }
    ],
    defaultModel: 'gemini-nano',
  },
  'groq': {
    name: '⚡ Groq (Free Tier Available)',
    requiresKey: true,
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Best)' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (Fastest)' },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  'gemini': {
    name: '💎 Google Gemini',
    requiresKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Fast)' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite (Fastest)' },
      { id: 'gemini-2.5-flash-preview-04-17', name: 'Gemini 2.5 Flash (Best)' },
    ],
    defaultModel: 'gemini-2.0-flash',
  },
  'openai': {
    name: '🟢 OpenAI (ChatGPT)',
    requiresKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cheap)' },
      { id: 'gpt-4o', name: 'GPT-4o (Best)' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini (Latest)' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano (Cheapest)' },
    ],
    defaultModel: 'gpt-4o-mini',
  },
  'anthropic': {
    name: '🟣 Anthropic (Claude)',
    requiresKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Best)' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (Fast)' },
    ],
    defaultModel: 'claude-sonnet-4-20250514',
  },
};

// ── Chrome Built-in AI Detection ──────────────────────────────
async function checkBuiltInAI() {
  try {
    if (typeof LanguageModel === 'undefined') {
      if (typeof self !== 'undefined' && self.ai && self.ai.languageModel) {
        return { available: true, legacy: true };
      }
      return { available: false, reason: 'Chrome Built-in AI is not available. Update Chrome to 138+ or use another provider.' };
    }
    const availability = await LanguageModel.availability();
    if (availability === 'available') {
      return { available: true, legacy: false };
    } else if (availability === 'downloadable' || availability === 'downloading') {
      return { available: true, needsDownload: true, legacy: false };
    }
    return { available: false, reason: `Built-in AI status: ${availability}. Enable chrome://flags/#optimization-guide-on-device-model or check requirements (22GB+ storage, 4GB+ VRAM or 16GB+ RAM).` };
  } catch (err) {
    return { available: false, reason: 'Built-in AI check failed: ' + err.message };
  }
}

// ── Core AI Call (Router) ─────────────────────────────────────
async function callAI(prompt, options = {}) {
  const settings = await getAiSettings();
  if (!settings.enabled) {
    throw new Error('AI is not enabled. Enable it in Settings.');
  }

  const provider = settings.provider || 'built-in';
  const { temperature = 0.7, maxTokens = 4096, jsonMode = false } = options;

  switch (provider) {
    case 'built-in':
      return callBuiltInAI(prompt, temperature, jsonMode);
    case 'gemini':
      if (!settings.apiKey) throw new Error('Gemini API key required. Set it in Settings.');
      return callGemini(prompt, settings.apiKey, settings.model || 'gemini-2.0-flash', temperature, maxTokens, jsonMode);
    case 'openai':
      if (!settings.apiKey) throw new Error('OpenAI API key required. Set it in Settings.');
      return callOpenAI(prompt, settings.apiKey, settings.model || 'gpt-4o-mini', temperature, maxTokens, jsonMode);
    case 'anthropic':
      if (!settings.apiKey) throw new Error('Anthropic API key required. Set it in Settings.');
      return callAnthropic(prompt, settings.apiKey, settings.model || 'claude-sonnet-4-20250514', temperature, maxTokens, jsonMode);
    case 'groq':
      if (!settings.apiKey) throw new Error('Groq API key required (free at console.groq.com). Set it in Settings.');
      return callGroq(prompt, settings.apiKey, settings.model || 'llama-3.3-70b-versatile', temperature, maxTokens, jsonMode);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── JSON Extraction Helper ────────────────────────────────────
function extractJSON(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('AI returned empty or non-string response');
  }
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const firstChar = (firstBrace === -1) ? firstBracket : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));
  const lastBrace = text.lastIndexOf('}');
  const lastBracket = text.lastIndexOf(']');
  const lastChar = Math.max(lastBrace, lastBracket);
  if (firstChar === -1 || lastChar === -1 || lastChar <= firstChar) {
    throw new Error('AI response did not contain valid JSON. Preview: ' + text.substring(0, 200));
  }
  const clean = text.substring(firstChar, lastChar + 1);
  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error('AI returned malformed JSON: ' + e.message);
  }
}

// ── Retry Helper ──────────────────────────────────────────────
async function retryWithBackoff(fn, maxAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const msg = err.message || '';

      // Do not retry hard limits
      if (msg.includes('FREE_TIER_EXHAUSTED')) throw err;

      // Only retry on rate-limit / server errors
      if (msg.includes('429') || Math.max(msg.indexOf('rate'), msg.indexOf('quota')) !== -1 || msg.includes('500') || msg.includes('503') || msg.includes('overloaded')) {
        const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
        console.warn(`[AI Service] Retry ${attempt + 1}/${maxAttempts} after ${waitMs}ms:`, msg);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err; // non-retryable
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER: Chrome Built-in AI (Gemini Nano — Free, On-Device)
// ═══════════════════════════════════════════════════════════════
async function callBuiltInAI(prompt, temperature, jsonMode) {
  const check = await checkBuiltInAI();
  if (!check.available) throw new Error(check.reason);

  let session;
  try {
    const createOpts = {};
    try {
      if (!check.legacy) {
        const params = await LanguageModel.params();
        createOpts.temperature = Math.min(temperature, params.maxTemperature || 2.0);
        createOpts.topK = params.defaultTopK || 3;
      }
    } catch (_) { }

    session = check.legacy
      ? await self.ai.languageModel.create(createOpts)
      : await LanguageModel.create(createOpts);

    const result = await session.prompt(prompt);
    session.destroy();

    if (!result || !result.trim()) throw new Error('Empty response from Built-in AI');
    return jsonMode ? extractJSON(result) : result;
  } catch (err) {
    if (session) try { session.destroy(); } catch (_) { }
    const msg = err.message || '';
    if (msg.includes('large') || msg.includes('long') || msg.includes('size')) {
      throw new Error('Your input is too large for the Built-in AI to process locally. Please use Groq (Free) or Gemini API instead.');
    }
    if (msg.includes('parse') || msg.includes('JSON')) {
      throw new Error('Built-in AI returned invalid JSON. Consider switching to a cloud provider (Groq is free!) for better results.');
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER: Google Gemini API
// ═══════════════════════════════════════════════════════════════
async function callGemini(prompt, apiKey, model, temperature, maxTokens, jsonMode) {
  const endpoints = [
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`,
  ];

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  };
  if (jsonMode) {
    body.contents[0].parts[0].text += '\n\nIMPORTANT: Return ONLY a valid JSON object or array. Do not include markdown blocks or any other text.';
  }

  let lastError = null;
  for (const url of endpoints) {
    try {
      const result = await retryWithBackoff(async () => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          const msg = err?.error?.message || `HTTP ${resp.status}`;
          if (msg.includes('free_tier') || msg.includes('limit: 0')) {
            throw new Error('FREE_TIER_EXHAUSTED: ' + msg);
          }
          throw new Error(msg);
        }
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty response from Gemini');
        return jsonMode ? extractJSON(text) : text;
      });
      return result;
    } catch (err) {
      lastError = err;
      if (err.message?.includes('FREE_TIER_EXHAUSTED')) continue; // try next endpoint
      if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('INVALID')) throw err;
    }
  }
  if (lastError?.message?.includes('FREE_TIER_EXHAUSTED')) {
    throw new Error('Your Gemini API Free Tier limit is 0 (or exhausted in your region). Please go to Settings and change your Provider to Groq (Free Tier).');
  }
  throw new Error(lastError?.message?.replace('FREE_TIER_EXHAUSTED: ', '') || 'Gemini API failed');
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER: OpenAI (GPT-4o, GPT-4o-mini, etc.)
// ═══════════════════════════════════════════════════════════════
async function callOpenAI(prompt, apiKey, model, temperature, maxTokens, jsonMode) {
  return retryWithBackoff(async () => {
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenAI');
    return jsonMode ? extractJSON(text) : text;
  });
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER: Anthropic Claude
// ═══════════════════════════════════════════════════════════════
async function callAnthropic(prompt, apiKey, model, temperature, maxTokens, jsonMode) {
  return retryWithBackoff(async () => {
    const systemPrompt = jsonMode
      ? 'You are a helpful assistant. Always respond with valid JSON only, no markdown or extra text.'
      : 'You are a helpful assistant.';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Claude HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.content?.[0]?.text;
    if (!text) throw new Error('Empty response from Claude');
    return jsonMode ? extractJSON(text) : text;
  });
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER: Groq (Free tier — Llama, Gemma, Mixtral)
// ═══════════════════════════════════════════════════════════════
async function callGroq(prompt, apiKey, model, temperature, maxTokens, jsonMode) {
  return retryWithBackoff(async () => {
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Groq HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from Groq');
    return jsonMode ? extractJSON(text) : text;
  });
}

// ═══════════════════════════════════════════════════════════════
// AI FEATURES
// ═══════════════════════════════════════════════════════════════

// ── Resume Parsing ───────────────────────────────────────────
async function parseResume(resumeText) {
  if (!resumeText || resumeText.trim().length < 30) {
    throw new Error('Resume text is too short to parse. Please provide more content.');
  }
  // Built-in AI has a small context window. We must safely truncate the text.
  const safeResumeText = resumeText.length > 5000
    ? resumeText.substring(0, 5000) + '\n...[TRUNCATED_DUE_TO_SIZE]'
    : resumeText;

  const prompt = `You are a professional resume parser. Your job is to READ the provided Resume Text below and EXTRACT the information to populate a JSON object.

IMPORTANT RULES:
1. You MUST extract actual values from the resume text.
2. If a field is missing from the resume, output null.
3. Be sure to check the "EMBEDDED PDF LINKS" section at the bottom of the text to accurately fill out linkedin, github, and portfolio URLs.
4. Return ONLY a valid JSON object matching the following structure exactly. Do not include markdown blocks like \`\`\`json.

YOUR OUTPUT MUST EXACTLY MATCH THIS JSON SCHEMA (replace descriptive values with extracted data):
{
  "firstName": "candidate's first name",
  "lastName": "candidate's last name",
  "email": "candidate's email",
  "phone": "candidate's phone number",
  "linkedin": "Any LinkedIn link found (e.g., linkedin.com/in/kushal)",
  "github": "Any GitHub link found (e.g., github.com/kushal)",
  "portfolio": "Any personal portfolio website link",
  "address": "street address",
  "city": "city",
  "state": "state",
  "zipcode": "zip code",
  "currentCompany": "most recent company",
  "currentTitle": "most recent job title",
  "summary": "professional summary",
  "totalExperienceYears": 5,
  "skills": ["skill 1", "skill 2"],
  "workHistory": [
    {
      "company": "company name",
      "title": "job title",
      "location": "location",
      "startDate": "start date",
      "endDate": "end date",
      "bullets": ["bullet point 1", "bullet point 2"]
    }
  ],
  "education": [
    {
      "school": "school name",
      "degree": "degree name",
      "field": "field of study",
      "startDate": "start date",
      "endDate": "end date",
      "gpa": "GPA"
    }
  ],
  "certifications": ["cert 1", "cert 2"],
  "languages": ["language 1", "language 2"]
}

--- RESUME TEXT TO PARSE ---
${safeResumeText}
`;
  return await callAI(prompt, { temperature: 0.1, maxTokens: 4096, jsonMode: true });
}

// ── Job Match Score ──────────────────────────────────────────
async function scoreJobMatch(jobDescription, profile) {
  if (!profile || Object.keys(profile).length === 0) {
    throw new Error('No profile data found. Please set up your Global Profile first.');
  }
  if (!jobDescription || jobDescription.trim().length < 50) {
    throw new Error('Job description is too short to analyze.');
  }
  const prompt = `You are a job matching expert. Analyze candidate-to-job fit.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2).substring(0, 2000)}

JOB DESCRIPTION:
"""
${jobDescription.substring(0, 4000)}
"""

Based on the profile and job description, return ONLY a JSON object exactly matching this structure:
{
  "overallScore": 85,
  "recommendation": "strong fit consider applying",
  "skillMatches": [
    { "skill": "JavaScript", "status": "match", "detail": "Strong experience" }
  ],
  "experienceMatch": { "score": 90, "detail": "Candidate has 5 years, job requires 3." },
  "educationMatch": { "score": 100, "detail": "Has required BS." },
  "salaryEstimate": "$100k-$130k or Not enough data",
  "keyStrengths": ["list of strengths"],
  "gaps": ["list of weak points"],
  "tips": ["actionable tip"]
}`;
  return await callAI(prompt, { temperature: 0.3, maxTokens: 2048, jsonMode: true });
}



// ── Resume Tailoring ─────────────────────────────────────────
async function tailorResume(jobDescription, profile) {
  if (!profile || Object.keys(profile).length === 0) {
    throw new Error('No profile data found. Please set up your Global Profile first.');
  }
  const prompt = `You are an expert resume writer and ATS specialist. Tailor this resume for the job.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

JOB DESCRIPTION:
"""
${jobDescription.substring(0, 4000)}
"""

Return JSON:
{
  "tailoredSummary": "rewritten professional summary for this role",
  "tailoredWorkHistory": [
    {
      "company": "string",
      "title": "string",
      "location": "string",
      "startDate": "string",
      "endDate": "string",
      "bullets": ["rewritten bullets emphasizing relevance"]
    }
  ],
  "highlightedSkills": ["skills ordered by relevance to JD"],
  "keywordsAdded": ["ATS keywords incorporated"],
  "changes": [
    { "section": "string", "change": "what changed and why" }
  ]
}

Rules:
- Rewrite bullets to use JD keywords naturally
- Reorder bullets: most relevant first
- Do NOT fabricate experience — only rephrase existing content
- Keep all positions, optimize descriptions`;

  return await callAI(prompt, { temperature: 0.4, maxTokens: 4096, jsonMode: true });
}

// ── AI Answer Generator ──────────────────────────────────────
async function generateAnswer(question, jobContext, profile) {
  const prompt = `Answer this job application question for the candidate.

CANDIDATE:
${JSON.stringify(profile, null, 2)}

JOB CONTEXT: ${jobContext || 'Not available'}

QUESTION: "${question}"

Rules:
- First person, authentic voice
- Reference REAL experience from the profile
- 2-4 sentences (unless question needs more)
- If numeric (e.g. "years of experience"), give just the number
- No quotes or markdown`;

  return await callAI(prompt, { temperature: 0.6, maxTokens: 512 });
}

// ── Smart Field Matching ─────────────────────────────────────
async function matchFields(fieldLabels, profileFieldNames) {
  const prompt = `Map form field labels to profile field names.

FORM LABELS: ${JSON.stringify(fieldLabels)}
PROFILE FIELDS: ${JSON.stringify(profileFieldNames)}

Return JSON: keys = form labels, values = matching profile field name (or null).
Example: {"First Name *": "firstName", "Favorite Color": null}`;

  return await callAI(prompt, { temperature: 0.1, maxTokens: 1024, jsonMode: true });
}

// ── Extract Job Info ─────────────────────────────────────────
async function extractJobInfo(pageContent) {
  const prompt = `Extract structured job posting info from this page content.

PAGE CONTENT:
"""
${pageContent.substring(0, 5000)}
"""

Return JSON:
{
  "companyName": "string or null",
  "jobTitle": "string or null",
  "location": "string or null",
  "jobType": "Remote/Hybrid/Onsite/null",
  "salaryRange": "string or null",
  "department": "string or null",
  "experienceLevel": "Entry/Mid/Senior/Lead/null",
  "requirements": ["string"],
  "responsibilities": ["string"],
  "benefits": ["string"],
  "isJobPosting": true/false
}`;
  return await callAI(prompt, { temperature: 0.2, maxTokens: 2048, jsonMode: true });
}

// ── Interview Prep ───────────────────────────────────────────
async function generateInterviewQuestions(jobDescription, profile) {
  const prompt = `Generate interview prep material for this candidate and job.

CANDIDATE:
${JSON.stringify(profile, null, 2)}

JOB DESCRIPTION:
"""
${jobDescription.substring(0, 4000)}
"""

Return JSON:
{
  "behavioralQuestions": [
    { "question": "string", "suggestedAnswer": "STAR format answer from candidate experience", "tip": "coaching tip" }
  ],
  "technicalQuestions": [
    { "question": "string", "suggestedAnswer": "string", "tip": "string" }
  ],
  "companyQuestions": [
    { "question": "string", "suggestedAnswer": "string", "tip": "string" }
  ],
  "questionsToAsk": [
    { "question": "smart question for the interviewer", "why": "why it's good" }
  ]
}

Generate 3-4 questions per category. Use candidate's ACTUAL experience for STAR answers.`;

  return await callAI(prompt, { temperature: 0.5, maxTokens: 4096, jsonMode: true });
}

// ── Follow-up Email ──────────────────────────────────────────
async function generateFollowUp(application, profile) {
  const days = Math.floor((Date.now() - new Date(application.appliedAt).getTime()) / 86400000);
  const prompt = `Write a follow-up email for a job application.

FROM: ${profile.firstName || ''} ${profile.lastName || ''}
COMPANY: ${application.companyName}
ROLE: ${application.jobTitle}
APPLIED: ${days} day(s) ago

Rules: Professional, warm, 3-4 short sentences, reference the role, express interest, not pushy.
Return ONLY email body (no greeting, no sign-off, no subject line).`;

  return await callAI(prompt, { temperature: 0.6, maxTokens: 256 });
}

// ═══════════════════════════════════════════════════════════════
// APPLICATION TRACKER
// ═══════════════════════════════════════════════════════════════
async function getApplications() {
  const result = await chrome.storage.local.get(APPLICATIONS_KEY);
  return result[APPLICATIONS_KEY] || [];
}

async function saveApplications(apps) {
  await chrome.storage.local.set({ [APPLICATIONS_KEY]: apps });
}

async function addApplication(app) {
  const apps = await getApplications();
  const exists = apps.find(a => a.companyName === app.companyName && a.jobTitle === app.jobTitle);
  if (exists) {
    Object.assign(exists, app, { updatedAt: new Date().toISOString() });
  } else {
    apps.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      ...app,
      status: app.status || 'applied',
      appliedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: '',
      jobDescription: app.jobDescription || '',
    });
  }
  await saveApplications(apps);
  return apps;
}

async function updateApplication(id, updates) {
  const apps = await getApplications();
  const app = apps.find(a => a.id === id);
  if (app) {
    Object.assign(app, updates, { updatedAt: new Date().toISOString() });
    await saveApplications(apps);
  }
  return apps;
}

async function deleteApplication(id) {
  let apps = await getApplications();
  apps = apps.filter(a => a.id !== id);
  await saveApplications(apps);
  return apps;
}
