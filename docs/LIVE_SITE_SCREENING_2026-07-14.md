# Public-site storage screening — 2026-07-14

## Result

FROST Guard attempted a passive visit to **130 public HTTPS origins** across
13 categories. **124 visits produced usable traces** and **6 failed at the
network layer twice**. The packaged classifier produced **zero public-site
candidates**.

This result does **not** establish that the measured sites are benign, that
they never use OPFS, or that FROST-like behavior is absent. It means only that
the classifier did not observe its configured rapid-growth pattern during the
recorded anonymous visits.

## Protocol

- 13 descriptive categories with 10 predeclared origins each.
- One anonymous page load per origin with no clicks, login, scrolling, consent
  interaction, search, or media playback.
- Four page-side `navigator.storage.estimate()` samples at five-second
  intervals after a three-second navigation settling period.
- A clean temporary Chromium profile for the main run, with the requested
  origin cleared before each visit. Retry and repeat runs used new profiles.
- Every result was checkpointed immediately. Failed visits remained in the
  denominator and received one clean-profile retry.
- Live traces were unlabeled. They were replayed through the exact packaged
  deterministic classifier and were not scored as expected-positive or
  expected-negative examples.

Before public browsing, the collector reran three controlled scenarios. The
256 MiB worker-based OPFS construction produced one
`confirmed-file-system-growth` event; the empty and 96 MiB benign scenarios
produced none.

## Cohort outcome

| Category | Attempted | Usable | Failed |
| --- | ---: | ---: | ---: |
| Commerce | 10 | 9 | 1 |
| Developer documentation | 10 | 10 | 0 |
| Education | 10 | 10 | 0 |
| Finance | 10 | 9 | 1 |
| Games | 10 | 10 | 0 |
| Maps | 10 | 10 | 0 |
| Media | 10 | 10 | 0 |
| News | 10 | 9 | 1 |
| Office and browser IDEs | 10 | 10 | 0 |
| Ordinary controls | 10 | 9 | 1 |
| PWA and offline-oriented sites | 10 | 10 | 0 |
| Social | 10 | 10 | 0 |
| Travel | 10 | 8 | 2 |
| **Total** | **130** | **124** | **6** |

## Largest observed increases

These are descriptive storage-estimate changes, not security findings.

| Origin | Category | Peak increase | Classifier event |
| --- | --- | ---: | --- |
| `https://open.spotify.com/` | Media | 41,569,685 bytes | None |
| `https://whatpwacando.today/` | PWA/offline | 20,427,652 bytes | None |
| `https://www.nytimes.com/` | News | 9,287,424 bytes | None |
| `https://excalidraw.com/` | PWA/offline | 458,756 bytes | None |
| `https://www.airbnb.com/` | Travel | 401,055 bytes | None |

All remained below the default 128 MiB confirmed file-system-growth threshold.
Page-side `usageDetails.fileSystem` was not available on these public traces,
so unattributed total growth remained subject to the separate 512 MiB log-only
threshold.

## Repeatability check

A fixed SHA-256 seed selected 13 of the 124 usable traces for a second
clean-profile run. Twelve showed zero growth in both runs. Excalidraw measured
458,756 bytes initially and 460,548 bytes on repeat. Neither run produced a
classifier event.

## Repeated collection failures

The following origins failed during both the main run and one clean-profile
retry. They are **not measurable**, not negative results.

- `https://www.costco.com/` — `net::ERR_HTTP2_PROTOCOL_ERROR`
- `https://www.washingtonpost.com/` — `net::ERR_HTTP2_PROTOCOL_ERROR`
- `https://www.fidelity.com/` — `net::ERR_HTTP2_PROTOCOL_ERROR`
- `https://www.hotels.com/` — `net::ERR_HTTP2_PROTOCOL_ERROR`
- `https://www.united.com/` — `net::ERR_HTTP2_PROTOCOL_ERROR`
- `https://httpstat.us/` — `net::ERR_EMPTY_RESPONSE`

## Interpretation boundaries

1. Observed storage growth does not establish malicious intent, abuse,
   tracking, persistence, resource exhaustion, or use of FROST.
2. `navigator.storage.estimate()` is approximate and origin-scoped. It does not
   identify which party, frame, worker, or script caused a change.
3. A negative result covers one short passive visit in headless Chromium from
   this machine and network. Geography, A/B tests, consent state, login state,
   interaction, advertisements, browser version, and time can change behavior.
4. The preselected cohort is not a probability sample of the web. It cannot
   establish classifier accuracy, sensitivity, specificity, or a public-web
   false-positive rate.
5. The screening measured growth behavior; it did not instrument every page or
   worker API call and therefore cannot prove that an origin never accessed
   OPFS.

## Reproducible artifacts

- Target corpus: `fixtures/calibration/public-sites-2026-07-14.json`
- Main traces: `fixtures/calibration/public-site-screening-2026-07-14.json`
- Main summary: `fixtures/calibration/public-site-screening-summary-2026-07-14.json`
- Retry targets/results: `fixtures/calibration/public-site-retries-2026-07-14.json`
  and `fixtures/calibration/public-site-retry-results-2026-07-14.json`
- Repeat targets/results/summary:
  `fixtures/calibration/public-site-repeat-sample-2026-07-14.json`,
  `fixtures/calibration/public-site-repeat-results-2026-07-14.json`, and
  `fixtures/calibration/public-site-repeat-summary-2026-07-14.json`
- Collector and report tools: `tools/calibration-collect.mjs` and
  `tools/calibration-report.mjs`

Replay and summarize the main corpus:

```bash
npm run calibration:replay -- fixtures/calibration/public-site-screening-2026-07-14.json
npm run calibration:report -- fixtures/calibration/public-site-screening-2026-07-14.json
```

Platform references:

- [MDN: Origin private file system](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system)
- [Chrome DevTools Protocol: Storage domain](https://chromedevtools.github.io/devtools-protocol/tot/Storage/)
- [HTTP Archive: Progressive Web Apps](https://httparchive.org/reports/progressive-web-apps)
