// The local web dashboard (`gh notif`, the default and only UI): a small local
// HTTP server (node:http, zero dependency) serving the notifications in an
// auto-refreshed and interactive web page (hiding, org/repo filter, manual
// refresh). A single poll loop feeds an in-memory snapshot; the HTTP requests
// serve it (several tabs ≠ more GitHub calls). Each new event pushes a desktop
// notification.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { collectPRs, recomputeCi } from './collect.js';
import { CATEGORY } from './filter.js';
import { hiddenPath, loadHidden, saveHidden, toggleHidden, isHidden, keyOf } from './hidden.js';
import { statePath, loadState, saveState, isNew, markSeen } from './state.js';
import { prefsPath, loadPrefs, savePrefs, isNotifyEnabled, themeOf, ignoredChecksOf, toggleIgnoredCheck, favModesOf, toggleFavMode, stacksOf, setStacks, hiddenColsOf, toggleHiddenCol } from './prefs.js';
import {
  parseScope, normalizeFavorites, addFavorite, removeFavorite,
  favoriteScopes, activeFavoriteOf, filterDataByScope, favoriteCounts, closedPRsUrl, reviewedPRsUrl, repoInAllMode,
} from './favorites.js';
import { diffApprovals } from './approvals.js';
import { normalizeSort, toggleSort, sortRows, groupStacks, SORT_KEYS, MINE_SORT_KEYS, DEFAULT_SORT } from './sort.js';
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

// Re-splits mine/hiddenMine and others/hidden from the in-memory data after a
// toggle, without refetching GitHub.
function recompute(data, hidden) {
  const split = (visible, hid) => {
    const all = [...(visible ?? []), ...(hid ?? [])];
    return [all.filter((r) => !isHidden(hidden, keyOf(r))), all.filter((r) => isHidden(hidden, keyOf(r)))];
  };
  const [mine, hiddenMine] = split(data.mine, data.hiddenMine);
  const [others, hiddenRows] = split(data.others, data.hidden);
  return { ...data, mine, hiddenMine, hiddenMineCount: hiddenMine.length, others, hidden: hiddenRows, hiddenCount: hiddenRows.length };
}

// HTML body of the fragment according to the snapshot state: error → escaped banner;
// no data yet (1st poll in progress) → spinner; otherwise → the tables.
// ⚠️ The snapshot contains the data of the UNION of favorites; the active
// favorite filter is applied HERE, at render time — never at collection (cf. §14).
function fragmentBody(snapshot, { now, showHidden, viewScope = null, closedUrl = null, reviewedUrl = null, sort = null, sortMine = null, ignoredChecks = {}, stacks = null, cols = null } = {}) {
  if (snapshot.error) return `<p class="empty offline">⚠️ Error: ${escapeHtml(snapshot.error)}</p>`;
  if (!snapshot.updatedAt) return renderLoading(viewScope?.value ?? '');
  let data = filterDataByScope(snapshot.data ?? { mine: [], others: [] }, viewScope);
  // Display sort of the « others » table (the hidden ones follow, consistency in
  // ?hidden=1 mode) and of « Your PRs » (independent state, its own key set).
  // `sort`/`sortMine` absent → collection order unchanged (compat).
  // Stacks mode is PER TABLE (`stacks` = { mine, others }, §20) and DROPS
  // that table's column sort: canonical view — the stacks first (root on top,
  // children below), the non-stacked rows after. The incoming rows are
  // pre-ordered updated-desc so the freshest block comes first,
  // deterministically. The persisted sort state survives untouched but is
  // neutralized at render: NO_SORT keeps the headers clickable (clicking a
  // column exits THAT table's stacks mode, POST /sort) with no active
  // column/arrow. The hidden rows (?hidden=1) keep a flat updated-desc order.
  // The other table is untouched: its own sort (or stacks) applies as usual.
  const NO_SORT = { key: null, dir: null };
  const stk = { mine: !!stacks?.mine, others: !!stacks?.others };
  if (stk.others) {
    data = { ...data, others: groupStacks(sortRows(data.others, DEFAULT_SORT)), hidden: sortRows(data.hidden, DEFAULT_SORT) };
    sort = NO_SORT;
  } else if (sort) {
    data = { ...data, others: sortRows(data.others, sort), hidden: sortRows(data.hidden, sort) };
  }
  if (stk.mine) {
    data = { ...data, mine: groupStacks(sortRows(data.mine, DEFAULT_SORT, MINE_SORT_KEYS)), hiddenMine: sortRows(data.hiddenMine, DEFAULT_SORT, MINE_SORT_KEYS) };
    sortMine = NO_SORT;
  } else if (sortMine) {
    data = { ...data, mine: sortRows(data.mine, sortMine, MINE_SORT_KEYS), hiddenMine: sortRows(data.hiddenMine, sortMine, MINE_SORT_KEYS) };
  }
  // `ignoredChecks` only affects the popover display (struck checks) — the CI
  // verdict itself was already recomputed at collection (§16).
  return renderFragment(data, { now, showHidden, closedUrl, reviewedUrl, sort, sortMine, ignoredChecks, stacks: stk, cols });
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
  if (!snapshot.updatedAt) return renderLoading(viewScope?.value ?? '');
  const data = filterDataByScope(snapshot.data ?? {}, viewScope);
  // rows = mine + others (hidden included) → « Checks by PR » section (job names for the blocklist).
  const rows = [...(data.mine ?? []), ...(data.hiddenMine ?? []), ...(data.others ?? []), ...(data.hidden ?? [])];
  return renderDebug(data?.debug ?? [], { now, rows, ignoredChecks });
}

// Routing of the reads (GET) — pure, no I/O. Testable without a socket.
export function handleRequest(pathname, snapshot, opts = {}) {
  const {
    now, intervalMs, showHidden, scope, notifyEnabled = true, theme = 'auto',
    favorites = [], activeFav = null, adhoc = false, sort = null, sortMine = null, ignoredChecks = {},
    favModes = null, stacks = null, cols = null,
  } = opts;
  // Display filter: the active favorite, except in ad-hoc mode (the entered scope
  // already drives the collection, re-filtering would be redundant).
  const viewScope = adhoc ? null : parseScope(activeFav);
  // « closed ↗ » / « my reviews ↗ » links contextualized on what the view displays.
  const links = linkScopes({ scope, activeFav, favorites });
  const closedUrl = closedPRsUrl(links);
  const reviewedUrl = reviewedPRsUrl(links);
  // Chip counters = others' activity per scope, on the raw UNION.
  const counts = favoriteCounts(favorites, snapshot.data);
  if (pathname === '/') {
    return { status: 200, type: 'text/html; charset=utf-8', body: renderShell({ intervalMs, scopeLabel: scopeLabel(scope), notifyEnabled, theme, favorites, activeFav, adhoc, counts, favModes }) };
  }
  if (pathname === '/fragment') {
    return { status: 200, type: 'text/html; charset=utf-8', body: fragmentBody(snapshot, { now, showHidden, viewScope, closedUrl, reviewedUrl, sort, sortMine, ignoredChecks, stacks, cols }) };
  }
  // Unified poll of the client: filtered tables + favorites bar (up-to-date counters)
  // + updatedAt (the client probes until it changes after an add/remove).
  if (pathname === '/view') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({
      chips: renderFavorites(favorites, activeFav, { adhoc, counts, favModes }),
      fragment: fragmentBody(snapshot, { now, showHidden, viewScope, closedUrl, reviewedUrl, sort, sortMine, ignoredChecks, stacks, cols }),
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
export function serve({ gh, me, scope: initialScope = null, all = false, port = 7777, intervalSeconds = POLL_SECONDS, open = true, notifier = sendNotification } = {}) {
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

  // Desktop notifications: dedup by URL via state.js, silent seed on the 1st
  // run (we only alert on what arrives afterwards).
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
  let sortMine = normalizeSort(prefs.sortMine, MINE_SORT_KEYS); // sort of « Your PRs » (persisted, Opened/Updated only)
  let stacks = stacksOf(prefs); // stacked-PRs grouping { mine, others } (persisted per table, POST /stacks?table=… toggles one)
  // favorites: pinned scopes (persisted). activeFav: the one we are looking at
  // (null = all). collectScope: what we actually request from GitHub.
  let favorites = normalizeFavorites(prefs.favorites);
  let activeFav = activeFavoriteOf(prefs, favorites);
  const collectScope = () => (scope ? scope : favoriteScopes(favorites));
  // « All » mode per favorite (watch everything: issues, third-party PRs).
  // `watchAllRepo` is consulted at collection; `muteWatch` silences the watch
  // categories for ONE refresh (the one right after enabling a mode): the
  // unread subscribed backlog is marked seen without notifying — same
  // philosophy as the 1st-run silent seed.
  let favModes = favModesOf(prefs); // mutable: POST /fav/mode toggles it
  const watchAllRepo = (repo) => repoInAllMode(favorites, favModes, repo);
  let muteWatch = false;
  const WATCH_CATEGORIES = new Set([CATEGORY.NEW_PR, CATEGORY.NEW_ISSUE, CATEGORY.ACTIVITY]);
  // CI blocklist per repo (manual edit of the prefs file): loaded once at
  // startup. Recomputes the CI verdict without the ignored jobs. ⚠️ Editing the file
  // while a --serve is running would be overwritten at the next POST (prefs object rewritten
  // in full) → edit with the server stopped, then relaunch.
  let ignoredChecks = ignoredChecksOf(prefs); // mutable: POST /ignore-check toggles it
  let cols = hiddenColsOf(prefs); // hidden columns per table (mutable: POST /cols toggles them)

  // Approvals on my PRs: in-memory state (per process), independent of the disk
  // state of the notifs. 1st poll = silent seeding (no burst at startup).
  const seenApprovals = new Set();
  let primedApprovals = false;

  const notifyNew = (data) => {
    // Approvals first (independent of the disk seed below): a new approve
    // → desktop notif. See approvals.js / spec.
    // diffApprovals ALWAYS records in seenApprovals (even when we do not notify)
    // → disabling the notifs = « mark seen silently », no burst on
    // re-enabling.
    const freshApprovals = diffApprovals({ events: data.approvalEvents ?? [], seen: seenApprovals, primed: primedApprovals });
    primedApprovals = true;
    if (notifyEnabled) for (const e of freshApprovals) notifier({ ...e, category: CATEGORY.APPROVAL });

    const items = data.notifications ?? [];
    if (!primed) {
      for (const item of items) markSeen(state, item);
      saveState(sPath, state);
      primed = true;
      return;
    }
    // PRs still open/pending (visible, hidden or mine): avoids
    // notifying a review request on an already closed/merged PR (cf. #7004).
    const openKeys = new Set([...data.mine, ...(data.hiddenMine ?? []), ...data.others, ...(data.hidden ?? [])].map((r) => `${r.repo}#${r.number}`));
    const fresh = items.filter((i) => isNew(state, i));
    for (const item of fresh) {
      markSeen(state, item); // always marked seen, even notifs off (no burst on re-enabling)
      // Silent seed of the watch categories right after enabling an « all »
      // mode: the pre-existing subscribed backlog must not burst (marked seen
      // above, notification skipped for this refresh only).
      if (muteWatch && WATCH_CATEGORIES.has(item.category)) continue;
      if (!notifyEnabled) continue;
      if (item.category === CATEGORY.REVIEW_REQUEST && !openKeys.has(`${item.repo}#${item.number}`)) continue;
      notifier(item);
    }
    if (fresh.length > 0) saveState(sPath, state);
  };

  const refresh = async () => {
    const stop = startSpinner('Updating…'); // terminal spinner (no-op outside TTY)
    try {
      // Collection over the UNION of favorites (or the ad-hoc scope). notifyNew receives
      // this raw data: this is what makes the desktop notifs of the
      // favorites we are not looking at arrive. The filtering is done at render (fragmentBody).
      const data = await collectPRs(gh, me, { all, scope: collectScope(), hidden, cache: inspectCache, ignoredChecks, watchAll: watchAllRepo });
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
    const counts = favoriteCounts(favorites, snapshot.data);
    return JSON.stringify({
      chips: renderFavorites(favorites, activeFav, { adhoc: !!scope, counts, favModes }),
      fragment: fragmentBody(snapshot, {
        now: Date.now(), showHidden,
        viewScope: scope ? null : parseScope(activeFav),
        closedUrl: closedPRsUrl(linkScopes({ scope, activeFav, favorites })),
        reviewedUrl: reviewedPRsUrl(linkScopes({ scope, activeFav, favorites })),
        sort,
        sortMine,
        ignoredChecks,
        stacks,
        cols,
      }),
      updatedAt: snapshot.updatedAt,
    });
  };
  const json = 'application/json; charset=utf-8';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const showHidden = url.searchParams.get('hidden') === '1';
    // no-store: without it the browser may serve a cached copy of `/` captured in a
    // past state (e.g. ad-hoc scope) after a server restart, instead of the
    // restored view (activeFav) — the page must always reflect the live server.
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

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
        // Removing a favorite cleans its mode key up (otherwise re-pinning it
        // later would silently resurrect the « all » mode).
        if (pathname === '/fav/rm' && prefs.favModes) {
          delete prefs.favModes[value.trim()];
          favModes = favModesOf(prefs);
        }
        // add → select the just-pinned favorite; rm → fall back to « all » if the active one was removed
        activeFav = pathname === '/fav/add'
          ? activeFavoriteOf({ activeFav: value }, favorites)
          : activeFavoriteOf({ activeFav }, favorites);
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
      if (pathname === '/fav/mode') {
        // Eye button of a chip: toggles the favorite's Normal / « all » mode
        // (watch everything: issues, third-party PRs — cf. ARCHITECTURE §18).
        const value = (url.searchParams.get('value') || '').trim();
        if (!favorites.includes(value)) {
          return send(400, 'text/plain; charset=utf-8', `unknown favorite: ${value}`);
        }
        toggleFavMode(prefs, value); // ⚠️ mutates prefs.favModes (rewritten IN FULL)
        savePrefs(prefsFile, prefs);
        favModes = favModesOf(prefs);
        if (favModes[value] === 'all') {
          // GitHub only emits subscribed threads for WATCHED repos → auto-watch
          // a repo favorite (best-effort/fail-open: a failure must not block the
          // toggle). An org favorite has no org-level watch: it covers the
          // repos of the org already watched by hand.
          const s = parseScope(value);
          if (s?.type === 'repo' && typeof gh.setRepoSubscription === 'function') {
            Promise.resolve(gh.setRepoSubscription(s.value)).catch(() => {});
          }
          // Anti-burst: the refresh below absorbs the unread subscribed backlog
          // silently (muteWatch → markSeen without notifying), then the flag drops.
          muteWatch = true;
          refresh().catch(() => {}).finally(() => { muteWatch = false; });
        } else {
          refresh().catch(() => {}); // clears the watched rows of this favorite
        }
        // Respond BEFORE the re-poll (instant chip), like /fav/add: the client
        // probes /view until updatedAt changes.
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/sort') {
        // Sort = pure display state: local recompute, NO GitHub call.
        // `table=mine` targets the « Your PRs » state (its own key set);
        // without it, the « others » one (historical behavior).
        const key = url.searchParams.get('key');
        const mine = url.searchParams.get('table') === 'mine';
        const keys = mine ? MINE_SORT_KEYS : SORT_KEYS;
        if (!keys.includes(key)) return send(400, 'text/plain; charset=utf-8', `unknown sort key: ${key ?? ''}`);
        // Sorting a column exits THAT table's stacks mode (§20): the stacked
        // view has no sort semantics, asking for a column order means leaving
        // it. The other table's stacks state is untouched (independent).
        setStacks(prefs, mine ? 'mine' : 'others', false); // ⚠️ mutates prefs (rewritten IN FULL below)
        stacks = stacksOf(prefs);
        if (mine) {
          sortMine = toggleSort(sortMine, key, MINE_SORT_KEYS);
          prefs.sortMine = sortMine; // ⚠️ mutate + rewrite IN FULL (otherwise notify/theme lost)
        } else {
          sort = toggleSort(sort, key);
          prefs.sort = sort; // ⚠️ mutate + rewrite IN FULL (otherwise notify/theme lost)
        }
        savePrefs(prefsFile, prefs);
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/stacks') {
        // Stacked-PRs grouping = pure display state, ONE flag per table
        // (`table=mine` targets « Your PRs », anything else « others »):
        // local recompute, NO GitHub call (same philosophy as /sort).
        const table = url.searchParams.get('table') === 'mine' ? 'mine' : 'others';
        setStacks(prefs, table, !stacks[table]); // ⚠️ mutates prefs (rewritten IN FULL)
        savePrefs(prefsFile, prefs);
        stacks = stacksOf(prefs);
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/cols') {
        // Column selector = pure display state: local recompute, NO GitHub
        // call (same philosophy as /sort). One hidden-columns list per table
        // (`table=mine` targets « Your PRs »). Valid keys = the table's sort
        // keys minus `title` (the pivot column, never hideable).
        const key = url.searchParams.get('key');
        const mine = url.searchParams.get('table') === 'mine';
        const keys = mine ? MINE_SORT_KEYS : SORT_KEYS;
        // `act` (the ✕ hide-button column) has no sort key but is hideable too.
        if (key === 'title' || (key !== 'act' && !keys.includes(key))) return send(400, 'text/plain; charset=utf-8', `unknown column: ${key ?? ''}`);
        toggleHiddenCol(prefs, mine ? 'mine' : 'others', key); // ⚠️ mutates prefs (rewritten IN FULL)
        savePrefs(prefsFile, prefs);
        cols = hiddenColsOf(prefs);
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
      sortMine,
      ignoredChecks,
      favModes,
      stacks,
      cols,
    });
    send(status, type, body);
  });

  server.on('close', () => clearTimeout(timer));
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    process.stderr.write(`🔔 gh notif · ${url} · Ctrl-C to stop\n`);
    if (open) openBrowser(url);
  });
  return server;
}
