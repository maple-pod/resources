# UI/UX screenshot matrix — maple-pod.github.io #6

Screenshot corpus for https://github.com/maple-pod/maple-pod.github.io/issues/6.

## Current baseline

- App repository: `maple-pod/maple-pod.github.io`
- App commit: `11c478d`
- Capture mode: production build (`pnpm build`) served via `pnpm preview`
- Themes: `light`, `dark`
- Viewports: `1920x1080`, `1180x820`, `820x1180`, `393x852`
- Screenshots use CSS-pixel viewport dimensions and the app's real resource data.

## Functional states

1. `playlists`
2. `playlist`
3. `playing-queue`
4. `recent-history`
5. `settings-menu`
6. `background-picker`
7. `about-dialog`
8. `create-playlist-dialog`
9. `playlist-filter`
10. `playlist-actions`
11. `music-actions`
12. `download-manager`

The complete current matrix contains 96 screenshots (`2 themes × 4 viewports × 12 states`).

## Deterministic fixture

The capture harness normalizes persisted user state before each batch: theme, no background image, fixed volume/playback preferences, a small liked list, a fixed custom playlist, and recent-history entries.

`Dragon Dream` is saved through the app's real **Download for Offline** UI flow when needed so the Download Manager state is reproducible without direct IndexedDB mutation.

Each theme/viewport batch is captured in a fresh Playwright page. `playing-queue` is captured last so playback and `beforeunload` behavior cannot affect other states. Animations/transitions and the development-only Vue DevTools widget are suppressed during capture. The product source tree itself is not modified by the capture process.

## Files

- `capture-harness.js` — Playwright capture procedure used by the agent-controlled browser.
- `manifest.json` / `manifest.csv` — current (`11c478d`) condition-to-file mapping, dimensions, byte size, and SHA-256.
- `manifest-f10c742.json` / `manifest-f10c742.csv` — archived manifest for the superseded first capture.
- `11c478d/<theme>/<viewport>/<state>.png` — current production-build screenshot corpus.
- `f10c742/<theme>/<viewport>/<state>.png` — superseded first capture retained for historical comparison; it was captured from the Vite development server and is not the current Issue #6 baseline.

## Validation

For `11c478d`:

- exactly 96 PNG files are present;
- every PNG exactly matches its requested CSS-pixel viewport dimensions;
- every matching light/dark viewport-state pair has a different SHA-256;
- the production `dist` contains build hash `11c478d` and does not contain the previous `f10c742` build hash.
