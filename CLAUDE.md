# CLAUDE.md

## ⚠️ READ FIRST, EVERY TIME

**Before any task on this repository, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** It describes
the modules, the data flow and above all the **non-obvious decisions** (pitfalls that have already
caused bugs: sticky `reason`, flattened review threads, dedup by URL,
typographic apostrophes…). Do not propose or write any code before re-reading it.

**The only UI is the local web page** (`gh notif` starts the server and opens the browser). There is
no terminal table rendering; `--serve`/`--watch` are deprecated no-ops kept so old invocations don't
error.

## Quick reference

- `gh` CLI extension, **Node ESM, zero npm dependency**. All GitHub access goes through `gh`.
- Tests: `npm test` (native `node:test` runner). The hard logic lives in **pure functions
  tested on fixtures** — add/maintain the tests, do not break the isolation (no network
  in tests).
- Before wrapping up a change: `npm test` green **and**
  `for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`, plus a smoke test if you
  touched the entrypoint or the web rendering (launch, curl `/`, then stop the process).
- **Every smoke test of the server MUST pass `--no-open`** (otherwise each launch opens a tab
  in the user's browser).
- The web page reuses the presentation helpers of `render.js` (`ciIcon`, `stateIcon`,
  `relativeDate`, `checksByRepo`); the HTML itself lives in `html.js` / `serve.js`.
