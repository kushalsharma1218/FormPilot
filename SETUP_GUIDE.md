# Cloud Sync Setup Guide

The Job Autofill extension now supports **Cross-Device Cloud Sync** using Firebase. 
This allows you to securely sync your profiles, saved sites, and job tracker data across all your browsers and devices.

Because this is a private extension for your own data, you need to create your own free Firebase project.

## Step 1: Create a Firebase Project
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Click **Create a project**.
3. Name it `job-autofill-sync` (or anything you like).
4. You can disable Google Analytics when asked.

## Step 2: Enable Authentication
1. In your Firebase project sidebar, click **Authentication** (under Build).
2. Click **Get Started**.
3. Click on the **Email/Password** provider and **Enable** only the first toggle. Save.

## Step 3: Enable Firestore Database
1. In the sidebar, click **Firestore Database**.
2. Click **Create database**.
3. Start in **Production mode**.
4. Choose a location closest to you.
5. Once created, go to the **Rules** tab and paste the following security rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```
*These rules ensure only you can read/write your own data.*

## Step 4: Add Firebase Config (No Code Changes)
1. Go to your Firebase Project Settings (the gear icon top left).
2. Under "Your apps", click the **Web `</>`** icon.
3. Register the app (name it `Job Autofill`).
4. You will be given a `firebaseConfig` object with your **API Key** and **Project ID**.
5. Open the extension **Dashboard** → **Cloud Sync**.
6. Paste **Firebase API Key** and **Project ID**, then click **Save Config**.

*This stores the config locally in `chrome.storage.local` and keeps it out of the repo.*

## Step 5: (Optional) Stable Extension ID (Recommended for Google Login)
If you want the **same extension ID across devices**, keep a private `manifest.key` file locally.

1. Generate a key (one time):
   ```bash
   openssl genrsa -out /tmp/job-autofill-key.pem 2048
   openssl rsa -in /tmp/job-autofill-key.pem -outform DER | openssl base64 -A > manifest.key
   ```
2. Apply the key to `manifest.json`:
   ```bash
   node scripts/apply-manifest-key.js
   ```
3. Reload the extension. Your ID will now stay the same across machines **as long as you reuse the same `manifest.key`**.

`manifest.key` is ignored by git and should never be committed.

## Step 6: (Optional) Enable Google Login

If you want to use the **Sign in with Google** button:

1. In the **Authentication** tab of Firebase Console, click "Add new provider" and select **Google**. Enable it and save.
2. Go to [Google Cloud Console](https://console.cloud.google.com/) (make sure you are in your Firebase project).
3. Search for "APIs & Services" -> **Credentials**.
4. You will see an **OAuth 2.0 Client ID** that Firebase auto-generated.
5. Create a new credential: **OAuth client ID** -> **Chrome app**.
6. Enter your Chrome Extension ID (found in `chrome://extensions/` under "Job Autofill" with Developer Mode on, e.g., `abcdefghijklmnop...`).
7. Copy the generated `Client ID`.
8. Open `manifest.json` in your code and replace `"YOUR_GOOGLE_OAUTH_CLIENT_ID"` with your copied ID.
9. *Note: If publishing the extension, or packing it, ensure you update the Key/Extension ID.*

## Step 7: Reload Extension
1. Go to `chrome://extensions/`
2. Click the reload icon `↻` on the Job Autofill extension.
3. Open the extension popup, and you will be asked to sign in to access your data!
