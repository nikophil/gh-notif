// Mode `gh notif --serve`: a small local HTTP server (node:http, zero
// dependency) that serves the same data as `gh notif` in an auto-refreshed
// and interactive web page (hiding, org/repo filter, manual refresh). A single
// poll loop feeds an in-memory snapshot; the HTTP requests serve it (several
// tabs ≠ more GitHub calls). Like `--watch`, each new event pushes a desktop
// notification.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { collectPRs, recomputeCi } from './collect.js';
import { CATEGORY } from './filter.js';
import { hiddenPath, loadHidden, saveHidden, toggleHidden, isHidden, keyOf } from './hidden.js';
import { statePath, loadState, saveState, isNew, markSeen } from './state.js';
import { prefsPath, loadPrefs, savePrefs, isNotifyEnabled, themeOf, ignoredChecksOf, toggleIgnoredCheck } from './prefs.js';
import {
  parseScope, normalizeFavorites, addFavorite, removeFavorite,
  favoriteScopes, activeFavoriteOf, filterDataByScope, favoriteCounts, closedPRsUrl,
} from './favorites.js';
import { diffApprovals } from './approvals.js';
import { normalizeSort, toggleSort, sortRows, SORT_KEYS } from './sort.js';
import { sendNotification } from './notify.js';
import { isRateLimitError, nextBackoffSeconds } from './ratelimit.js';
import { startSpinner } from './spinner.js';
import { renderShell, renderFragment, renderLoading, renderDebug, renderDebugShell, renderFavorites, escapeHtml } from './html.js';

const POLL_SECONDS = 60;
const BACKOFF_CAP = 600; // ceiling of the backoff on rate-limit (10 min)
const REFRESH_MIN_AGE_MS = 10_000; // debounce of POST /refresh (see shouldRefresh)

// `parseScope` lives in favorites.js (pure module, without node:http) because the CLI
// and the favorites need it; re-exported here where it has always been consumed.
export { parseScope };

// Label of a scope to pre-fill the input field ('' = all).
// In favorites mode, `scope` is an ARRAY (the union): the field stays empty, it is
// the chips that carry the information.
export function scopeLabel(scope) {
  return scope && !Array.isArray(scope) ? scope.value : '';
}

// Debounce of POST /refresh: the client sends one on EVERY page load
// (ctrl+R = « really refresh »), so we only re-poll GitHub if the
// snapshot is older than `minAgeMs` (otherwise spamming ctrl+R = spamming GitHub, cf.
// rate-limit §11). `updatedAt` null (1st poll not done) → always poll.
export function shouldRefresh(updatedAt, now, minAgeMs = REFRESH_MIN_AGE_MS) {
  return updatedAt == null || now - updatedAt >= minAgeMs;
}

// Re-filters others/hidden from the in-memory data after a toggle, without
// refetching GitHub (same logic as the terminal entrypoint).
function recompute(data, hidden) {
  const all = [...(data.others ?? []), ...(data.hidden ?? [])];
  const others = all.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = all.filter((r) => isHidden(hidden, keyOf(r)));
  return { ...data, others, hidden: hiddenRows, hiddenCount: hiddenRows.length };
}

// HTML body of the fragment according to the snapshot state: error → escaped banner;
// no data yet (1st poll in progress) → spinner; otherwise → the tables.
// ⚠️ The snapshot contains the data of the UNION of favorites; the active
// favorite filter is applied HERE, at render time — never at collection (cf. §14).
function fragmentBody(snapshot, { now, showHidden, viewScope = null, closedUrl = null, sort = null } = {}) {
  if (snapshot.error) return `<p class="empty offline">⚠️ Error: ${escapeHtml(snapshot.error)}</p>`;
  if (!snapshot.updatedAt) return renderLoading();
  let data = filterDataByScope(snapshot.data ?? { mine: [], others: [] }, viewScope);
  // Display sort of the « others » table (the hidden ones follow, consistency in
  // ?hidden=1 mode). `sort` absent → collection order unchanged (compat).
  if (sort) data = { ...data, others: sortRows(data.others, sort), hidden: sortRows(data.hidden, sort) };
  return renderFragment(data, { now, showHidden, closedUrl, sort });
}

// Scope(s) that the view DISPLAYS, to contextualize the « closed ↗ » link:
// ad-hoc > active favorite > union of favorites > null (all of GitHub). Distinct from
// `viewScope` (display filter), which is null in ad-hoc (collection already targeted)
// and null on « all » (the union is already collected).
function linkScopes({ scope = null, activeFav = null, favorites = [] } = {}) {
  return scope ?? parseScope(activeFav) ?? favoriteScopes(favorites);
}

// Body of the debug fragment (pipeline verdict) — same error/loading handling.
function debugBody(snapshot, { now, viewScope = null, ignoredChecks = {} } = {}) {
  if (snapshot.error) return `<p class="empty offline">⚠️ Error: ${escapeHtml(snapshot.error)}</p>`;
  if (!snapshot.updatedAt) return renderLoading();
  const data = filterDataByScope(snapshot.data ?? {}, viewScope);
  // rows = mine + others + hidden → « Checks by PR » section (job names for the blocklist).
  const rows = [...(data.mine ?? []), ...(data.others ?? []), ...(data.hidden ?? [])];
  return renderDebug(data?.debug ?? [], { now, rows, ignoredChecks });
}

// Routing of the reads (GET) — pure, no I/O. Testable without a socket.
export function handleRequest(pathname, snapshot, opts = {}) {
  const {
    now, intervalMs, showHidden, scope, notifyEnabled = true, theme = 'auto',
    favorites = [], activeFav = null, adhoc = false, sort = null, ignoredChecks = {},
  } = opts;
  // Display filter: the active favorite, except in ad-hoc mode (the entered scope
  // already drives the collection, re-filtering would be redundant).
  const viewScope = adhoc ? null : parseScope(activeFav);
  // « closed ↗ » link contextualized on what the view displays.
  const closedUrl = closedPRsUrl(linkScopes({ scope, activeFav, favorites }));
  // Chip counters = others' activity per scope, on the raw UNION.
  const counts = favoriteCounts(favorites, snapshot.data?.others);
  if (pathname === '/') {
    return { status: 200, type: 'text/html; charset=utf-8', body: renderShell({ intervalMs, scopeLabel: scopeLabel(scope), notifyEnabled, theme, favorites, activeFav, adhoc, counts }) };
  }
  if (pathname === '/fragment') {
    return { status: 200, type: 'text/html; charset=utf-8', body: fragmentBody(snapshot, { now, showHidden, viewScope, closedUrl, sort }) };
  }
  // Unified poll of the client: filtered tables + favorites bar (up-to-date counters)
  // + updatedAt (the client probes until it changes after an add/remove).
  if (pathname === '/view') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({
      chips: renderFavorites(favorites, activeFav, { adhoc, counts }),
      fragment: fragmentBody(snapshot, { now, showHidden, viewScope, closedUrl, sort }),
      updatedAt: snapshot.updatedAt,
    }) };
  }
  if (pathname === '/api/state') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(snapshot) };
  }
  // Debug mode (always-on): standalone page + its fragment + raw JSON.
  if (pathname === '/debug') {
    return { status: 200, type: 'text/html; charset=utf-8', body: renderDebugShell({ intervalMs }) };
  }
  if (pathname === '/debug-fragment') {
    return { status: 200, type: 'text/html; charset=utf-8', body: debugBody(snapshot, { now, viewScope, ignoredChecks }) };
  }
  if (pathname === '/api/debug') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(snapshot.data?.debug ?? []) };
  }
  return { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
}

// Opens the browser on the URL (best-effort, silent failure).
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* browser not openable: we already logged the URL */
  }
}

// Starts the poll loop + the HTTP server. The scope is mutable (UI filter).
// Returns the server to allow a clean shutdown in tests.
//
// Two notions not to be confused (cf. ARCHITECTURE.md §14):
//  - `scope` (ad-hoc mode) or the union of favorites = what we COLLECT;
//  - `activeFav` = a simple DISPLAY filter, changed without any request.
export function serve({ gh, me, scope: initialScope = null, all = false, port = 7777, intervalSeconds = POLL_SECONDS, open = true } = {}) {
  // `scope` non-null ⇒ ad-hoc mode: an entered scope (--org/--repo or web field)
  // takes precedence over the favorites, which become purely decorative (greyed chips).
  let scope = initialScope;
  const snapshot = { data: { mine: [], others: [] }, updatedAt: null, error: null };

  // Inspection cache reused between polls (unchanged thread = 0 request).
  const inspectCache = new Map();
  let backoff = 0; // seconds added to the interval after a rate-limit

  // Hiding: reflects the persisted state (same view as `gh notif`).
  const hiddenFile = hiddenPath();
  const hidden = loadHidden(hiddenFile);

  // Desktop notifications (like --watch): dedup by URL via state.js, silent
  // seed on the 1st run (we only alert on what arrives afterwards).
  const sPath = statePath();
  let primed = existsSync(sPath);
  const state = loadState(sPath);

  // UI preferences persisted on disk. We keep the `prefs` object in memory and
  // mutate+save it IN FULL (otherwise a POST /notify would overwrite the `theme` key, and
  // vice versa — lost-key bug). notify: desktop notifs (checkbox).
  // theme: CSS skin (auto/light/dark, switcher). Driven by POST /notify & /theme.
  const prefsFile = prefsPath();
  const prefs = loadPrefs(prefsFile);
  let notifyEnabled = isNotifyEnabled(prefs);
  let theme = themeOf(prefs);
  let sort = normalizeSort(prefs.sort); // sort of the « others » table (persisted)
  // favorites: pinned scopes (persisted). activeFav: the one we are looking at
  // (null = all). collectScope: what we actually request from GitHub.
  let favorites = normalizeFavorites(prefs.favorites);
  let activeFav = activeFavoriteOf(prefs, favorites);
  const collectScope = () => (scope ? scope : favoriteScopes(favorites));
  // CI blocklist per repo (manual edit of the prefs file): loaded once at
  // startup. Recomputes the CI verdict without the ignored jobs. ⚠️ Editing the file
  // while a --serve is running would be overwritten at the next POST (prefs object rewritten
  // in full) → edit with the server stopped, then relaunch.
  let ignoredChecks = ignoredChecksOf(prefs); // mutable: POST /ignore-check toggles it

  // Approvals on my PRs: in-memory state (per process), independent of the disk
  // state of the notifs. 1st poll = silent seeding (no burst at startup).
  const seenApprovals = new Set();
  let primedApprovals = false;

  const notifyNew = (data) => {
    // Approvals first (independent of the disk seed below): a new approve
    // → desktop notif, like --watch. See approvals.js / spec.
    // diffApprovals ALWAYS records in seenApprovals (even when we do not notify)
    // → disabling the notifs = « mark seen silently », no burst on
    // re-enabling.
    const freshApprovals = diffApprovals({ events: data.approvalEvents ?? [], seen: seenApprovals, primed: primedApprovals });
    primedApprovals = true;
    if (notifyEnabled) for (const e of freshApprovals) sendNotification({ ...e, category: CATEGORY.APPROVAL });

    const items = data.notifications ?? [];
    if (!primed) {
      for (const item of items) markSeen(state, item);
      saveState(sPath, state);
      primed = true;
      return;
    }
    // PRs still open/pending (visible, hidden or mine): avoids
    // notifying a review request on an already closed/merged PR (cf. #7004).
    const openKeys = new Set([...data.mine, ...data.others, ...(data.hidden ?? [])].map((r) => `${r.repo}#${r.number}`));
    const fresh = items.filter((i) => isNew(state, i));
    for (const item of fresh) {
      markSeen(state, item); // always marked seen, even notifs off (no burst on re-enabling)
      if (!notifyEnabled) continue;
      if (item.category === CATEGORY.REVIEW_REQUEST && !openKeys.has(`${item.repo}#${item.number}`)) continue;
      sendNotification(item);
    }
    if (fresh.length > 0) saveState(sPath, state);
  };

  const refresh = async () => {
    const stop = startSpinner('Updating…'); // terminal spinner (no-op outside TTY)
    try {
      // Collection over the UNION of favorites (or the ad-hoc scope). notifyNew receives
      // this raw data: this is what makes the desktop notifs of the
      // favorites we are not looking at arrive. The filtering is done at render (fragmentBody).
      const data = await collectPRs(gh, me, { all, scope: collectScope(), hidden, cache: inspectCache, ignoredChecks });
      if (data.hiddenChanged) saveHidden(hiddenFile, hidden);
      notifyNew(data);
      snapshot.data = data;
      snapshot.updatedAt = Date.now();
      snapshot.error = null;
      backoff = 0; // success: we restart at the normal interval
    } catch (err) {
      if (isRateLimitError(err.message)) {
        backoff = nextBackoffSeconds(backoff, intervalSeconds, BACKOFF_CAP);
        snapshot.error = `⏳ rate-limited by GitHub — retrying in ${backoff}s`;
      } else {
        snapshot.error = err.message;
      }
    } finally {
      stop();
    }
  };

  // Loop rescheduled by setTimeout (and not setInterval) to integrate the
  // backoff: the next poll is deferred by `intervalSeconds + backoff`.
  let timer = null;
  const loop = async () => {
    await refresh();
    timer = setTimeout(loop, (intervalSeconds + backoff) * 1000);
  };
  loop();

  // Unified response of the actions (JSON {chips, fragment, updatedAt}): the favorites
  // bar lives in the <header> (outside #content), so we return both
  // pieces and the client injects them separately — the counters stay up to date.
  // (Unlike /notify & /theme, whose widget has nothing to re-render → 204.)
  const currentView = (showHidden) => {
    const counts = favoriteCounts(favorites, snapshot.data?.others);
    return JSON.stringify({
      chips: renderFavorites(favorites, activeFav, { adhoc: !!scope, counts }),
      fragment: fragmentBody(snapshot, {
        now: Date.now(), showHidden,
        viewScope: scope ? null : parseScope(activeFav),
        closedUrl: closedPRsUrl(linkScopes({ scope, activeFav, favorites })),
        sort,
      }),
      updatedAt: snapshot.updatedAt,
    });
  };
  const json = 'application/json; charset=utf-8';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const showHidden = url.searchParams.get('hidden') === '1';
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };

    if (req.method === 'POST') {
      if (pathname === '/refresh') {
        // Debounced: fresh snapshot (< 10 s) → we respond with the current view without
        // touching GitHub (the client forces /refresh on every page load).
        if (shouldRefresh(snapshot.updatedAt, Date.now())) await refresh();
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/hide') {
        const key = url.searchParams.get('key');
        if (key) {
          toggleHidden(hidden, key, snapshot.data?.notifications ?? []);
          saveHidden(hiddenFile, hidden);
          snapshot.data = recompute(snapshot.data, hidden);
        }
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/scope') {
        // Manual entry → ad-hoc mode (the chips go greyed); field cleared
        // → back to favorites mode (or all of GitHub if no favorite).
        scope = parseScope(url.searchParams.get('value'));
        await refresh();
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/fav') {
        // Changing the active favorite = pure display filter: NO GitHub
        // call… except if we were leaving ad-hoc mode (the union is not collected).
        const value = (url.searchParams.get('value') || '').trim();
        activeFav = favorites.includes(value) ? value : null;
        prefs.activeFav = activeFav; // ⚠️ mutate + rewrite IN FULL (otherwise notify/theme lost)
        savePrefs(prefsFile, prefs);
        if (scope) { scope = null; await refresh(); }
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/fav/add' || pathname === '/fav/rm') {
        const value = url.searchParams.get('value') || '';
        // Not allowed to pin a scope that does not exist on GitHub (a
        // quick check, ~1 request). Tri-state: false → clean 400; null
        // (network, rate-limit…) → fail-open, we do not wrongly prevent the add.
        if (pathname === '/fav/add' && typeof gh.scopeExists === 'function') {
          const s = parseScope(value);
          if (s && (await gh.scopeExists(s)) === false) {
            return send(400, 'text/plain; charset=utf-8', s.type === 'repo'
              ? `repository ${s.value} not found on GitHub`
              : `org/user ${s.value} not found on GitHub`);
          }
        }
        try {
          favorites = pathname === '/fav/add' ? addFavorite(favorites, value) : removeFavorite(favorites, value);
        } catch (err) {
          return send(400, 'text/plain; charset=utf-8', err.message);
        }
        activeFav = activeFavoriteOf({ activeFav }, favorites); // removed favorite → « all »
        prefs.favorites = favorites;
        prefs.activeFav = activeFav;
        savePrefs(prefsFile, prefs);
        scope = null; // pinning/removing means wanting the favorites view
        // ⚠️ refresh in the BACKGROUND: the response leaves right away (the chip
        // appears without waiting for the poll); the client probes /view until
        // updatedAt changes to see counters and tables update.
        refresh().catch(() => {});
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/sort') {
        // Sort = pure display state: local recompute, NO GitHub call.
        const key = url.searchParams.get('key');
        if (!SORT_KEYS.includes(key)) return send(400, 'text/plain; charset=utf-8', `unknown sort key: ${key ?? ''}`);
        sort = toggleSort(sort, key);
        prefs.sort = sort; // ⚠️ mutate + rewrite IN FULL (otherwise notify/theme lost)
        savePrefs(prefsFile, prefs);
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/ignore-check') {
        // Checkbox of the debug view: toggles a job in the repo blocklist,
        // persists, then RECOMPUTES LOCALLY the ci of all the rows (0 GitHub call:
        // row.checks is already in memory). Responds with the re-rendered debug fragment (checkboxes +
        // up-to-date verdicts); the dashboard picks up the CI icons on its next /view.
        const repo = url.searchParams.get('repo');
        const name = url.searchParams.get('name');
        if (repo && name) {
          toggleIgnoredCheck(prefs, repo, name); // ⚠️ mutates prefs.ignoredChecks (rewritten IN FULL)
          savePrefs(prefsFile, prefs);
          ignoredChecks = ignoredChecksOf(prefs);
          if (snapshot.data) recomputeCi(snapshot.data, ignoredChecks);
        }
        const viewScope = scope ? null : parseScope(activeFav);
        return send(200, 'text/html; charset=utf-8', debugBody(snapshot, { now: Date.now(), viewScope, ignoredChecks }));
      }
      if (pathname === '/notify') {
        notifyEnabled = url.searchParams.get('enabled') !== '0';
        prefs.notify = notifyEnabled;
        savePrefs(prefsFile, prefs);
        // The checkbox lives in the header (outside #content): no need to re-render the
        // tables, an acknowledgment is enough.
        return send(204, 'text/plain; charset=utf-8', '');
      }
      if (pathname === '/theme') {
        // Normalizes (unknown value → auto). The switcher lives in the header and
        // already applies data-theme on the client side → an acknowledgment is enough.
        theme = themeOf({ theme: url.searchParams.get('value') });
        prefs.theme = theme;
        savePrefs(prefsFile, prefs);
        return send(204, 'text/plain; charset=utf-8', '');
      }
      return send(404, 'text/plain; charset=utf-8', 'Not found');
    }

    const { status, type, body } = handleRequest(pathname, snapshot, {
      now: Date.now(),
      // The page refresh follows the real GitHub poll interval
      // (the re-fetch only re-reads the server snapshot, 0 GitHub call).
      intervalMs: intervalSeconds * 1000,
      showHidden,
      scope,
      notifyEnabled,
      theme,
      favorites,
      activeFav,
      adhoc: !!scope,
      sort,
      ignoredChecks,
    });
    send(status, type, body);
  });

  server.on('close', () => clearTimeout(timer));
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    process.stderr.write(`🔔 gh notif --serve · ${url} · Ctrl-C to stop\n`);
    if (open) openBrowser(url);
  });
  return server;
}
