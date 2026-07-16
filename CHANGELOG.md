# Changelog

## 0.2.0 — 2026-07-14

- Blocks `navigator.storage.getDirectory()` in page and worker contexts.
- Blocks Storage Bucket OPFS and synchronous file access handles.
- Wraps dedicated and shared workers before their original scripts execute.
- Uses an offline-calibrated deterministic classifier to confirm sustained rapid browser file-system growth.
- Keeps fallback total-growth signals log-only and requires explicit user action for cleanup.
- Adds in-page warnings, toolbar badges, desktop notifications, and a local event log.
- Adds one-hour and permanent per-origin exceptions.
- Adds per-origin OPFS and service-worker cleanup.
- Uses Manifest V3 with no runtime or development dependencies.
