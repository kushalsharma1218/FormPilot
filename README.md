# Job Autofill

A lightweight, fully local Chrome Extension that automates the process of filling out repetitive online job applications.

## 🚀 Features
- **Form Data Capture**: Automatically captures and records your common application form data when you hit submit on a job application.
- **Smart Autofill**: Remembers your inputs and cleanly autofills them when you visit other applications, saving you time.
- **Privacy First**: All data is stored **locally** on your device using Chrome storage. Nothing is ever sent to an external server. By default, sensitive fields (SSNs, banking, etc.) are explicitly excluded.
- **Handles Moden ATS Platforms**: Advanced logic effectively supports dynamic elements, ARIA comboboxes/listboxes, and complex multi-page tracking.
- **Cross-origin Iframe Support**: Automatically groups application data under the company's real top-level domain, even when the job board is hosted inside an iframe (like on Greenhouse or Workday).

## 🛠️ Installation
1. Clone or download this repository to your local machine.
2. Open Chrome and go to `chrome://extensions/`.
3. Toggle **Developer mode** ON in the top right corner.
4. Click **Load unpacked** and select the top-level directory of this project.
5. The extension icon will now appear in your browser's toolbar!

## 💡 Usage
1. Navigate to a supported job application page.
2. Click the extension icon to manage the site settings, make sure the autofill functionality is toggled on.
3. Fill out the application manually for the first time. Upon pressing "Submit/Apply/Next", a banner will cleanly ask if you want to save the captured data. 
4. The next time you visit a similar application on that company's website, an Autofill banner will dynamically appear indicating you can instantly populate the fields!

## 💻 Tech Stack
* HTML, CSS, JavaScript (Vanilla UI)
* Chrome Extension API (Manifest V3)
