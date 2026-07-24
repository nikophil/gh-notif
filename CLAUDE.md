# CLAUDE.md

## ⚠️ READ FIRST, EVERY TIME

**Before any task on this repository, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** It describes
the modules, the data flow and above all the **non-obvious decisions** (pitfalls that have already
caused bugs: sticky `reason`, flattened review threads, dedup by URL, emoji width,
typographic apostrophes…). Do not propose or write any code before re-reading it.

## Quick reference

- `gh` CLI extension, **Node ESM, zero npm dependency**. All GitHub access goes through `gh`.
- Tests: `npm test` (native `node:test` runner). The hard logic lives in **pure functions
  tested on fixtures** — add/maintain the tests, do not break the isolation (no network
  in tests).
- Before wrapping up a change: `npm test` green **and**
  `for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`, plus a smoke test if you
  touched the entrypoint or the rendering.
- **Every smoke test of `--serve` MUST pass `--no-open`** (otherwise each launch opens a tab
  in the user's browser).
- Table alignment depends on `render.js#displayWidth`: any new icon/emoji must
  pass the alignment test (all rows of a table have the same width).
