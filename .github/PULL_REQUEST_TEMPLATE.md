## What / Why

Describe the change and the problem it solves. Link any issue (`Fixes #123`).

## How

A sentence or two on the approach, especially if it touches the host↔client
boundary or the record/status accounting.

## Test plan

- [ ] `npm test` passes locally (should be green — CI runs 105 tests on
      Ubuntu / Windows / macOS × Node 22 / 24). Inside a DSH session use
      `npm run test:sandbox` instead — the sandbox rejects `spawn`, so node
      needs `--experimental-test-isolation=none`.
- [ ] If you changed `lib/index.js` or `lib/core/**`: note that the host half
      is loaded at boot, so reviewers need a full DSH restart, not just a page
      refresh, to see it.
- [ ] If you changed `lib/client.js`: a page refresh is enough.
- [ ] `npm run check:install` passes against an installed copy.

## Screenshots

For UI changes, add before/after (the stats heatmap and completion cards
especially).
