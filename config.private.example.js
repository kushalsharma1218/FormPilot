// Private Firebase config (copy to config.private.js)
// This file is NOT loaded unless you create config.private.js in the extension root.
// Do NOT commit your real keys.
globalThis.PRIVATE_FIREBASE_CONFIG = {
  apiKey: 'YOUR_FIREBASE_WEB_API_KEY',
  projectId: 'your-firebase-project-id',
  authDomain: 'your-firebase-project-id.firebaseapp.com',
};

// Optional AI config (kept private)
globalThis.PRIVATE_AI_CONFIG = {
  provider: 'groq',
  apiKey: 'YOUR_GROQ_API_KEY',
  model: 'llama-3.3-70b-versatile',
  enabled: true,
};
