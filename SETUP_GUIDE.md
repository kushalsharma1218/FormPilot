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

## Step 4: Add Config to Code
1. Go to your Firebase Project Settings (the gear icon top left).
2. Under "Your apps", click the **Web `</>`** icon.
3. Register the app (name it `Job Autofill`).
4. You will be given a `firebaseConfig` object with your API Key and Project ID.
5. Open `cloud-sync.js` in the extension code.
6. Paste your `apiKey` and `projectId` into the `FIREBASE_CONFIG` object at the top of the file:

```javascript
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDocX...',
  projectId: 'job-autofill-sync-123',
};
```

## Step 5: Reload Extension
1. Go to `chrome://extensions/`
2. Click the reload icon `↻` on the Job Autofill extension.
3. Open the Dashboard Settings tab, and you can now Sign Up and start syncing!
