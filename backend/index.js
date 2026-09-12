require('dotenv').config();

// Polyfill fetch for Node.js 14
const fetch = require('node-fetch');
globalThis.fetch = fetch;
globalThis.Headers = fetch.Headers;
globalThis.Request = fetch.Request;
globalThis.Response = fetch.Response;

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// ── CORS ───────────────────────────────────────────────────────
// Default-deny. Set ALLOWED_ORIGINS to a comma-separated list, e.g.
//   ALLOWED_ORIGINS=chrome-extension://abcdef...,http://localhost:5173
// An empty list allows only same-origin/no-origin callers (curl, tests).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true); // curl, server-to-server, tests
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin not allowed: ${origin}`));
    },
}));
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting ──────────────────────────────────────────────
// Small in-process fixed-window limiter. Good enough for a single instance;
// use a shared store (Redis) if this is ever run behind more than one process.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const rateBuckets = new Map();

function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const bucket = rateBuckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
        rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else if (bucket.count >= RATE_LIMIT_MAX) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many requests. Retry in ${retryAfter}s.` });
    } else {
        bucket.count += 1;
    }

    // Opportunistic cleanup so the map cannot grow without bound.
    if (rateBuckets.size > 10_000) {
        for (const [key, value] of rateBuckets) {
            if (now >= value.resetAt) rateBuckets.delete(key);
        }
    }
    return next();
}

// Set up multer for file uploads in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 } // 5MB limit
});

// Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'MISSING_KEY');

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Job Autofill AI Backend is running' });
});

// PDF Parse and Analyze Route
app.post('/api/parse-resume', rateLimit, upload.single('resume'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'No resume file uploaded' });
        }

        if (file.mimetype !== 'application/pdf') {
            // Currently only supporting PDF on this route for simplicity. 
            // Text and docx can be added later if needed via mammoth/etc.
            return res.status(400).json({ error: 'Only PDF files are supported currently' });
        }

        // 1. Extract text from PDF
        const pdfData = await pdfParse(file.buffer);
        const resumeText = pdfData.text;

        if (!resumeText || resumeText.trim().length < 50) {
            return res.status(400).json({ error: 'Could not extract sufficient text from this PDF' });
        }

        // 2. Let Gemini parse it into our Global Profile JSON format
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        // We can also allow the extension to pass its own API key to avoid server billing
        const apiKeyHeader = req.headers['x-gemini-api-key'];
        let activeModel = model;
        if (apiKeyHeader) {
            if (typeof apiKeyHeader !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(apiKeyHeader)) {
                return res.status(400).json({ error: 'Malformed x-gemini-api-key header' });
            }
            const customGenAI = new GoogleGenerativeAI(apiKeyHeader);
            activeModel = customGenAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        } else if (!process.env.GEMINI_API_KEY) {
            return res.status(400).json({
                error: 'No Gemini API key available. Send your own key in the x-gemini-api-key header.'
            });
        }

        const prompt = `You are a professional resume parser. Extract ALL structured data from the following resume text.

Return ONLY a valid JSON object with this EXACT structure (no markdown fences, just the JSON string):
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
  ]
}

Resume text:
"""
${resumeText}
"""`;

        // Retry logic for rate limiting / quota issues
        let result;
        let lastErr;

        const modifiedPrompt = prompt + '\n\nIMPORTANT: Return ONLY a valid JSON object or array. Do not include markdown blocks or any other text.';

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                result = await activeModel.generateContent({
                    contents: [{ role: 'user', parts: [{ text: modifiedPrompt }] }],
                    generationConfig: {
                        temperature: 0.1
                    }
                });
                break; // success
            } catch (genErr) {
                lastErr = genErr;
                const errMsg = genErr.message || '';
                if (errMsg.includes('quota') || errMsg.includes('rate') || errMsg.includes('429') || errMsg.includes('free_tier')) {
                    const waitMs = 2000 * Math.pow(2, attempt);
                    console.warn(`[Backend] Rate limit/quota error on attempt ${attempt + 1}. Waiting ${waitMs}ms...`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
                throw genErr; // non-retryable error
            }
        }

        if (!result) {
            const errMsg = lastErr?.message || 'Unknown error';
            if (errMsg.includes('quota') || errMsg.includes('free_tier') || errMsg.includes('limit: 0')) {
                return res.status(429).json({
                    error: 'API quota exceeded. Your Gemini free tier may be exhausted. ' +
                        'Please enable billing on your Google Cloud project at https://console.cloud.google.com/billing, ' +
                        'or create a new API key at https://aistudio.google.com/apikey, ' +
                        'or wait for your quota to reset (usually resets daily).'
                });
            }
            throw lastErr;
        }

        const responseText = result.response.text();
        let parsedData;
        try {
            const firstBrace = responseText.indexOf('{');
            const firstBracket = responseText.indexOf('[');
            const firstChar = (firstBrace === -1) ? firstBracket : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));
            const lastBrace = responseText.lastIndexOf('}');
            const lastBracket = responseText.lastIndexOf(']');
            const lastChar = Math.max(lastBrace, lastBracket);
            const cleanText = firstChar !== -1 && lastChar !== -1 ? responseText.substring(firstChar, lastChar + 1) : responseText;
            parsedData = JSON.parse(cleanText);
        } catch (parseErr) {
            console.error("Failed to parse Gemini JSON:", responseText);
            return res.status(500).json({ error: 'AI returned invalid JSON format' });
        }

        return res.json({
            success: true,
            message: 'Resume parsed successfully',
            data: parsedData
        });

    } catch (error) {
        console.error('Error parsing resume:', error);
        res.status(500).json({ error: error.message || 'Internal server error while parsing resume' });
    }
});

// Turn CORS rejections into a clean 403 rather than a 500 stack trace.
app.use((err, req, res, next) => {
    if (err && /^Origin not allowed/.test(err.message || '')) {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Resume exceeds the 5MB limit' });
    }
    console.error('[Backend] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Job Autofill Backend listening on port ${port}`);
    });
}

module.exports = { app };
