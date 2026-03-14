# HireFlow AI — Ultimate Career Copilot 🚀

A powerful, privacy-first Chrome Extension that automates job applications using local data and AI-powered intelligence.

## 🚀 Key Features

- **🤖 AI Job Copilot**:
    - **Resume Parsing**: Upload your PDF/TXT resume and let AI extract your profile automatically.
    - **Match Scoring**: Get an instant score on how well your profile matches a specific job description.
    - **Cover Letter Generator**: Generate tailored, professional cover letters based on the job requirements.
    - **Interview Prep**: Get custom behavioral and technical interview questions based on your experience and the job role.
- **🌍 Global Profile**: Store your master personal data (Name, Email, LinkedIn, etc.) once and use it across ALL job portals.
- **✨ Smart Autofill**: Remembers your inputs and cleanly autofills them when you visit other applications, saving you hours of work.
- **📊 Application Tracker**: Automatically track your submitted applications, update statuses, and set follow-up reminders.
- **🛡️ Privacy First**: All your personal data is stored **locally** on your device. You keep control of your data and your API keys.
- **🧩 Advanced Field Detection**: Robust heuristics to identify fields on complex ATS platforms like Greenhouse, Workday, Lever, and more.

## 🛠️ Installation

1. Clone or download this repository to your local machine.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Toggle **Developer mode** ON in the top right corner.
4. Click **Load unpacked** and select the top-level directory of this project.
5. Pin the extension to your toolbar for easy access!

## 💡 Usage

### 1. Set Up Your Profile
Click the extension icon and select **Settings** or **Profile**. Upload your resume to auto-populate your details, or fill them in manually.

### 2. Configure AI (Optional but Recommended)
In the **Settings** tab, enter your Google Gemini API Key. This enables the AI Copilot features like match scoring and cover letter generation.

### 3. Apply with Confidence
Navigate to any job posting. The **AI Copilot** will show up in your extension popup to help you evaluate the role and prepare your application!

## 💻 Tech Stack
* **Frontend**: HTML5, CSS3 (Vanilla), JavaScript (ES6+)
* **Extension**: Chrome Extension API (Manifest V3)
* **Backend (AI Parsing)**: Node.js, Express, pdf-parse, Google Gemini AI
* **Storage**: `chrome.storage.local`

---
*Built for job seekers who want to work smarter, not harder.*
