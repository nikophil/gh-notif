import { scopeMatches, scopesQualifier } from './collect.js';

// Scope favorites: a list of strings (`symfony`, `noctud/collection`, …)
// pinned by the user, persisted in prefs-v1.json.
//
// ⚠️ Structuring decision (cf. ARCHITECTURE.md §14): **collection** covers the
// UNION of favorites (so that the desktop notifs of every perimeter arrive
// continuously), and the active favorite is only a **display filter** applied
// downstream, on data already in memory. Switching favorite therefore costs
// no GitHub request.
//
// Everything is pure here (like hidden.js / state.js); persistence lives in prefs.js.

// Guard rail: GitHub limits a search query to 256 characters, and the union
// qualifier grows with the list. The real constraint is therefore the LENGTH,
// not the count (10 favorites with short names pass, 6 with very long names
// don't). We refuse at add time, with a clear message, rather than silently
// truncating at collection. Budget = 256 minus the longest of the base queries
// (`is:open is:pr review-requested:@me`, 34 characters) + margin.
export const MAX_QUALIFIER_LENGTH = 200;

// Scope value (favorite or input field) → scope object, same semantics as
// --org/--repo. Empty → null (all). Contains « / » → repo (owner/name). Otherwise → org.
// Lives here (the purest module) and not in serve.js: favorites and the CLI need it
// without pulling in node:http.
export function parseScope(value) {
  const v = (value || '').trim();
  if (!v) return null;
  return v.includes('/') ? { type: 'repo', value: v } : { type: 'org', value: v };
}

// Sanitized favorites list: non-empty strings, trimmed, deduplicated, order
// preserved. Robust against an old or tampered prefs-v1.json (same philosophy
// as themeOf) — any unusable value is simply ignored.
export function normalizeFavorites(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const v = entry.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// Adds a favorite (idempotent). Throws if the value is empty or if the
// resulting list would exceed the query length budget — the caller (CLI / web
// route) surfaces the message as-is.
export function addFavorite(list, value) {
  const favorites = normalizeFavorites(list);
  const v = (value || '').trim();
  if (!v) throw new Error('a favorite requires a value (e.g. symfony or noctud/collection)');
  if (favorites.includes(v)) return favorites;
  const next = [...favorites, v];
  if (scopesQualifier(favoriteScopes(next)).length > MAX_QUALIFIER_LENGTH) {
    throw new Error(
      `too many favorites: the GitHub search would exceed ${MAX_QUALIFIER_LENGTH} characters. `
      + 'Remove one (gh notif fav rm <scope>) or prefer an org over several repos.',
    );
  }
  return next;
}

// Removes a favorite. Missing value → list unchanged (no-op, no error).
export function removeFavorite(list, value) {
  const v = (value || '').trim();
  return normalizeFavorites(list).filter((f) => f !== v);
}

// Favorites list → list of scope objects, for collection (union).
// Empty list → null, which means « no filter » everywhere downstream.
export function favoriteScopes(list) {
  const scopes = normalizeFavorites(list).map(parseScope).filter(Boolean);
  return scopes.length > 0 ? scopes : null;
}

// Validated active favorite: null (= « all favorites ») if absent, unknown, or
// removed from the list since the last save.
export function activeFavoriteOf(prefs, list) {
  const favorites = normalizeFavorites(list);
  const active = typeof prefs?.activeFav === 'string' ? prefs.activeFav.trim() : '';
  return active && favorites.includes(active) ? active : null;
}

// Next favorite in the `f` key cycle:
// null (all) → list[0] → … → list[n-1] → null. An unknown `current` restarts from
// the beginning; an empty list stays on null.
export function cycleFavorite(list, current) {
  const favorites = normalizeFavorites(list);
  if (favorites.length === 0) return null;
  const i = favorites.indexOf(current);
  if (i < 0) return favorites[0];
  return i + 1 < favorites.length ? favorites[i + 1] : null;
}

// Display label of a favorite: an **org** becomes `symfony/*` (« all its
// repos »), a **repo** stays `owner/name`. ⚠️ Purely cosmetic — the stored
// value, the `data-fav` and the URL argument stay the raw string (`symfony`).
export function favoriteLabel(value) {
  const v = (value || '').trim();
  if (!v) return '';
  return v.includes('/') ? v : `${v}/*`;
}

// Badge per favorite = number of PRs in « activity on others' PRs »
// (`data.others`, already excluding hidden ones) that fall under this scope; `total` = all.
// ⚠️ Computed on the raw UNION (not the filtered view) so that each favorite displays
// **its own** count, including those we're not looking at.
export function favoriteCounts(favorites, others) {
  const rows = Array.isArray(others) ? others : [];
  const byFav = {};
  for (const f of normalizeFavorites(favorites)) {
    const s = parseScope(f);
    byFav[f] = rows.filter((r) => scopeMatches(s, r?.repo)).length;
  }
  return { total: rows.length, byFav };
}

// External link to MY closed PRs (merged + closed) on GitHub, contextualized
// on the displayed scope(s) — null, a single scope, or the union (array). No
// collection nor pagination on the gh-notif side: GitHub handles the display.
export function closedPRsUrl(scopes) {
  return `https://github.com/pulls?q=${encodeURIComponent(`is:pr author:@me is:closed${scopesQualifier(scopes)}`)}`;
}

// DISPLAY filter: restricts already-collected data to a scope.
// ⚠️ Apply only downstream of collectPRs AND notifyNew — filtering upstream
// would break the desktop notifs of inactive favorites, the pruning of `hidden`
// (reconcile) and the dedup of state.js (cf. ARCHITECTURE.md §14).
export function filterDataByScope(data, scope) {
  if (!scope || !data) return data;
  const keep = (r) => scopeMatches(scope, r?.repo);
  const hidden = (data.hidden ?? []).filter(keep);
  return {
    ...data,
    mine: (data.mine ?? []).filter(keep),
    others: (data.others ?? []).filter(keep),
    hidden,
    hiddenCount: hidden.length,
    notifications: (data.notifications ?? []).filter(keep),
    debug: (data.debug ?? []).filter(keep),
  };
}
