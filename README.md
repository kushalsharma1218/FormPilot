# FormPilot AI

Chrome extension for job-form autofill, profile capture, resume handling, task tracking, and AI-assisted application workflows.

## Active App Layout

Load the unpacked extension from the repository root.

The active code lives here:

- `manifest.json`: extension entry point
- `background.js`: service worker and storage orchestration
- `content.js`: page detection, autofill, learning, overlays
- `popup/`: browser action popup
- `dashboard/`: full dashboard UI
- `lib/`: shared storage and field utilities
- `assets/`, `icons/`: static assets
- `dev/`: local test pages and fixtures for manual QA
- `tests/`: automated Node-based tests
- `backend/`: optional Node backend for AI parsing flows

## Legacy And Archive Layout

Old or superseded code is isolated so the active extension root stays clean:

- `legacy/extensions/job-autofill-v1/`: older extension copy kept for reference
- `legacy/debug/`: archived scratch files and debug artifacts
- `dev/fixtures/`: local resume fixtures used for manual testing

Nothing under `legacy/` is used by the current extension runtime.

## Common Commands

From the repo root:

```bash
npm test
```

Run the real-site e2e helper:

```bash
npm run e2e:real
```

From `backend/` (optional — only needed for server-side PDF resume parsing):

```bash
cp .env.example .env   # then set ALLOWED_ORIGINS to your extension id
npm test
node index.js
```

## Local Setup

1. Copy `config.private.example.js` to `config.private.js` and fill in your Firebase values
2. Open `chrome://extensions/`
3. Turn on Developer Mode
4. Click `Load unpacked`
5. Select this repository's root directory

## Notes

- `config.private.js` is local-only runtime config. It must not contain an AI
  `apiKey`: FormPilot is bring-your-own-key and users enter theirs in
  Dashboard → Settings → AI. Anything bundled there ships inside the packaged
  extension and can be extracted by anyone who installs it.
- Autofill runs in local-only mode by default. Dashboard → Settings → Autofill Mode
  switches it to require sign-in.
- `manifest.key` stays out of git and should remain private.
- Keep new experiments inside `dev/`, `tests/`, or `legacy/` instead of the repo root.
