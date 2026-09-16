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
- **Once the work is done**: `systemctl --user restart gh-notif` — the app runs as a user
  systemd service on :7777 (`Restart=always`) and keeps serving the OLD code until restarted.
- **Every smoke test of the server MUST pass `--no-open`** (otherwise each launch opens a tab
  in the user's browser).
- The web page reuses the presentation helpers of `render.js` (`ciIcon`, `stateIcon`,
  `relativeDate`, `checksByRepo`); the HTML itself lives in `html.js` / `serve.js`.

## Releases

Versions ship as **GitHub releases**: the update banner (§32) only fires on a new release,
so a push to `main` that is not released reaches nobody.

- **After every push to `main`, suggest cutting a release** (suggest, never create it
  unasked). Semver: patch for a fix, minor for a feature.
- Release = bump `version` in `package.json`, commit, then create the release with
  **hand-written, user-facing notes**. Never `--generate-notes`: GitHub builds those from
  merged PRs, and this repo commits straight to `main` → the notes would only hold the
  changelog link.
- Notes = what the user gains, not the commit log. List the commits since the previous
  tag (`git fetch --tags && git log --oneline v<prev>..HEAD`), then group them by
  **Features** / **Fixes** and describe each in one or two sentences a user of the page
  understands (what it does, how to use it, e.g. « click *allow in browser* »).
  Skip docs/chore/refactor commits. End with the compare link.

  ```bash
  gh release create v<version> --title "v<version>" --notes-file notes.md
  ```

  Template of `notes.md`:

  ```markdown
  ## Features
  - **Browser notifications** — the page can now notify you itself (…how to enable…).

  ## Fixes
  - **…** — what was wrong, what happens now.

  **Full Changelog**: https://github.com/nikophil/gh-notif/compare/v<prev>...v<version>
  ```
