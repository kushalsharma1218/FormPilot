# FormPilot AI

Chrome extension for job-form autofill, profile capture, resume handling, task tracking, and AI-assisted application workflows.

## Active App Layout

Load the unpacked extension from the repository root:

`/Users/Kushal.Sharma1/.gemini/antigravity/playground/Side project/Job-Auto-Fill-New`

The active code lives here:

- `manifest.json`: extension entry point
- `background.js`: service worker and storage orchestration
- `content.js`: page detection, autofill, learning, overlays
- `popup/`: browser action popup
- `dashboard/`: full dashboard UI
- `options/`: extension options page
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

From `backend/`:

```bash
npm test
node index.js
```

## Local Setup

1. Open `chrome://extensions/`
2. Turn on Developer Mode
3. Click `Load unpacked`
4. Select `/Users/Kushal.Sharma1/.gemini/antigravity/playground/Side project/Job-Auto-Fill-New`

## Notes

- `config.private.js` is local-only runtime config.
- `manifest.key` stays out of git and should remain private.
- Keep new experiments inside `dev/`, `tests/`, or `legacy/` instead of the repo root.
