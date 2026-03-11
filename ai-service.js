// ai-service.js — Centralized AI Service for Job Autofill
// Loaded by background.js via importScripts()

const AI_SETTINGS_KEY = 'ai_settings';
const APPLICATIONS_KEY = 'applications_data';

// ── Settings Management ──────────────────────────────────────
async function getAiSettings() {
  const result = await chrome.storage.local.get(AI_SETTINGS_KEY);
  return result[AI_SETTINGS_KEY] || {
    enabled: false,
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-2.0-flash',
  };
}

async function saveAiSettings(settings) {
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
}

// ── Core AI Call ──────────────────────────────────────────────
async function callAI(prompt, options = {}) {
  const settings = await getAiSettings();
  if (!settings.enabled || !settings.apiKey) {
    throw new Error('AI is not configured. Please set your API key in Settings.');
  }
  const { temperature = 0.7, maxTokens = 4096, jsonMode = false } = options;

  if (settings.provider === 'gemini') {
    return callGemini(prompt, settings.apiKey, settings.model, temperature, maxTokens, jsonMode);
  }
  throw new Error(`Unsupported provider: ${settings.provider}`);
}

async function callGemini(prompt, apiKey, model, temperature, maxTokens, jsonMode) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || resp.statusText);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from AI');
  if (jsonMode) {
    // Strip anything before the first { or [ and after the last } or ]
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    const firstChar = (firstBrace === -1) ? firstBracket : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));
    const lastBrace = text.lastIndexOf('}');
    const lastBracket = text.lastIndexOf(']');
    const lastChar = Math.max(lastBrace, lastBracket);
    const clean = firstChar !== -1 && lastChar !== -1 ? text.substring(firstChar, lastChar + 1) : text;
    return JSON.parse(clean);
  }
  return text;
}

// ── Resume Parsing ───────────────────────────────────────────
async function parseResume(resumeText) {
  const prompt = `You are a professional resume parser. Extract ALL structured data.

Return a JSON object with this EXACT structure:
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "phone": "string",
  "linkedin": "string or empty",
  "github": "string or empty",
  "portfolio": "string or empty",
  "address": "string or empty",
  "city": "string or empty",
  "state": "string or empty",
  "zipcode": "string or empty",
  "currentCompany": "string or empty",
  "currentTitle": "string or empty",
  "summary": "professional summary or objective",
  "totalYearsExperience": 0,
  "skills": ["skill1", "skill2"],
  "workHistory": [
    {
      "company": "string",
      "title": "string",
      "location": "string or empty",
      "startDate": "Jan 2020",
      "endDate": "Present",
      "bullets": ["achievement1", "achievement2"]
    }
  ],
  "education": [
    {
      "school": "string",
      "degree": "string",
      "field": "string or empty",
      "startDate": "string or empty",
      "endDate": "string or empty",
      "gpa": "string or empty"
    }
  ],
  "certifications": ["cert1"],
  "languages": ["English"]
}

Resume text:
"""
${resumeText}
"""`;
  return await callAI(prompt, { temperature: 0.1, maxTokens: 4096, jsonMode: true });
}

// ── Job Match Score ──────────────────────────────────────────
async function scoreJobMatch(jobDescription, profile) {
  const prompt = `You are a job matching expert. Analyze candidate-to-job fit.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

JOB DESCRIPTION:
"""
${jobDescription.substring(0, 6000)}
"""

Return JSON:
{
  "overallScore": 0-100,
  "recommendation": "1-2 sentence advice",
  "skillMatches": [
    { "skill": "string", "status": "match|partial|missing", "detail": "brief explanation" }
  ],
  "experienceMatch": { "score": 0-100, "detail": "string" },
  "educationMatch": { "score": 0-100, "detail": "string" },
  "salaryEstimate": "salary range string or 'Not enough data'",
  "keyStrengths": ["string"],
  "gaps": ["string"],
  "tips": ["actionable tip"]
}`;
  return await callAI(prompt, { temperature: 0.3, maxTokens: 2048, jsonMode: true });
}

// ── Cover Letter Generator ───────────────────────────────────
async function generateCoverLetter(jobDescription, profile, tone = 'professional') {
  const tones = {
    professional: 'Write in a formal, polished, professional tone.',
    conversational: 'Write in a warm, conversational, personable tone.',
    bold: 'Write in a confident, assertive, bold tone.'
  };
  const prompt = `Write a tailored cover letter for this candidate.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

JOB DESCRIPTION:
"""
${jobDescription.substring(0, 4000)}
"""

TONE: ${tones[tone] || tones.professional}

Rules:
- 3-4 paragraphs, 250-350 words
- Compelling opening (NOT "I am writing to apply for...")
- Reference specific requirements from the JD
- Highlight 2-3 most relevant achievements
- Close with confidence & call to action
- Return ONLY body text, no headers/addresses/sign-off`;

  return await callAI(prompt, { temperature: 0.7, maxTokens: 1024 });
}

// ── Resume Tailoring ─────────────────────────────────────────
async function tailorResume(jobDescription, profile) {
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

// ── Applications Tracker ─────────────────────────────────────
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
