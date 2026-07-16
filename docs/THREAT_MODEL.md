# Threat model

## Protected scenario

A user visits an untrusted HTTP(S) page. The page attempts to allocate a large
Origin Private File System (OPFS) file and repeatedly time random reads—often
inside a dedicated worker—to infer storage contention caused by other websites
or native applications.

FROST Guard aims to stop the probe before the origin receives an OPFS root or a
synchronous access handle. It also watches reported browser-storage usage for
sustained rapid file-system growth and lets the user remove the origin's
file-system data and service worker explicitly.

## Security goals

1. Inject before ordinary page scripts on protected navigations.
2. Replace the documented OPFS and worker entry points in the page's main
   JavaScript world.
3. Make replacement descriptors non-configurable and non-writable where the
   browser permits.
4. Catch alternate `Worker.prototype.constructor` access.
5. Alert the user without relying on page-controlled UI.
6. Keep all logs local and execute no remote code.

## Out of scope and residual risk

- Rewriting or instrumenting an already-running website service worker.
- Eliminating all microarchitectural, storage, cache, scheduling, or timer side
  channels in a general-purpose browser.
- Preventing native applications from observing storage activity.
- Defending pages where Chrome policy or another extension prevents injection.
- Guaranteed coverage of races involving newly created same-origin realms before
  Chrome dispatches document-start content scripts.
- Attacks that use unrelated storage APIs without suspicious growth or OPFS.

The popup's purge control deletes the origin's browser file-system data and
service worker. Use it after installation for suspicious tabs that were already
open, then reload those tabs.
