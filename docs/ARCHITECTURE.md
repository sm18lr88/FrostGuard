# Architecture

## Dynamic document-start registration

The Manifest V3 service worker registers two scripts for all HTTP(S) frames:

- `src/main-shield.js` in Chrome's `MAIN` execution world.
- `src/bridge.js` in the extension's `ISOLATED` execution world.

Dynamic registration allows permanent and temporary origin exceptions to be
converted into `excludeMatches` without granting a page access to extension
state.

## Main-world shield

The main-world script patches:

- `StorageManager.getDirectory`
- `StorageBucket.getDirectory`
- `FileSystemFileHandle.createSyncAccessHandle`
- `FileSystemFileHandle.createAccessHandle` when present
- `Worker` and `SharedWorker`, including their prototype constructor paths

Worker wrappers start a local blob bootstrap, install the worker-side patches,
then load the original worker. Classic-worker `importScripts()` calls are
resolved against the original worker URL to preserve common relative imports.
Module workers import the original module URL directly.

## Isolated bridge

The bridge receives a narrow allowlist of events from the page world and relays
them to the extension service worker. It owns the in-page warning banner. The
top-frame storage monitor polls `navigator.storage.estimate()` and passes each
sample through the deterministic classifier. Only confirmed file-system growth
can escalate to a badge or notification; total-growth signals remain log-only,
and no heuristic signal triggers automatic deletion.

## Service worker

The extension service worker owns dynamic registration, notifications, badge
state, the local event log, settings, exceptions, and per-origin cleanup using
`chrome.browsingData.remove()` for `fileSystems` and `serviceWorkers`.
