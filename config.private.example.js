// Private Firebase config (copy to config.private.js)
// This file is NOT loaded unless you create config.private.js in the extension root.
// Do NOT commit your real keys.
globalThis.PRIVATE_FIREBASE_CONFIG = {
  apiKey: 'YOUR_FIREBASE_WEB_API_KEY',
  projectId: 'your-firebase-project-id',
  authDomain: 'your-firebase-project-id.firebaseapp.com',
};

// Optional AI defaults. NOTE: apiKey is intentionally absent — FormPilot is
// bring-your-own-key. Anything bundled here ships inside the packaged extension
// and can be extracted by anyone who installs it. Users enter their own key in
// Dashboard → Settings → AI.
globalThis.PRIVATE_AI_CONFIG = {
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
};
