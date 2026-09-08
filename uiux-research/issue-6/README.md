# UI/UX screenshot matrix — maple-pod.github.io #6

Baseline corpus for https://github.com/maple-pod/maple-pod.github.io/issues/6.

## Baseline

- App repository: `maple-pod/maple-pod.github.io`
- App commit: `f10c742`
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

The complete matrix contains 96 screenshots (`2 themes × 4 viewports × 12 states`).

## Deterministic fixture

The capture harness normalizes persisted user state before each batch: theme, no background image, fixed volume/playback preferences, a small liked list, a fixed custom playlist, and recent-history entries. `Dragon Dream` is saved through the app's real offline-download flow so the Download Manager has a stable visible state.

Animations/transitions and the development-only Vue DevTools widget are suppressed during capture. The product source tree itself is not modified for this research run.

## Files

- `capture-harness.js` — Playwright capture procedure used by the agent-controlled browser.
- `manifest.json` / `manifest.csv` — exact condition-to-file mapping, dimensions, byte size, and SHA-256.
- `f10c742/<theme>/<viewport>/<state>.png` — screenshot corpus.

The manifest was validated to contain exactly 96 PNGs, all at their requested viewport dimensions, with distinct light/dark images for every matching viewport/state pair.
