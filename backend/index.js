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

// Middleware
app.use(cors());
app.use(express.json());

// Set up multer for file uploads in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'MISSING_KEY');

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Job Autofill AI Backend is running' });
});

// PDF Parse and Analyze Route
app.post('/api/parse-resume', upload.single('resume'), async (req, res) => {
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
            const customGenAI = new GoogleGenerativeAI(apiKeyHeader);
            activeModel = customGenAI.getGenerativeModel({ model: "gemini-2.0-flash" });
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

        const result = await activeModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        });

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

app.listen(port, () => {
    console.log(`Job Autofill Backend listening on port ${port}`);
});
