import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TRIGGER_FOR } from './filter.js';

// Persistence + pure logic for hiding PRs (others' AND mine, same map/mechanism).
// The interaction (✕ button) lives in the web page; here, everything is testable.

export function hiddenPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'hidden-v1.json');
}

export function loadHidden(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function saveHidden(path, map) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2));
}

export function keyOf(x) {
  return `${x.repo}#${x.number}`;
}

// URLs of the notification items that carry a trigger (mention/reply/comment)
// for this PR. review_request is excluded (absent from TRIGGER_FOR): its signature
// is therefore empty — a hidden requested review stays hidden until a real
// interaction (cf. ARCHITECTURE §10).
export function signatureOf(key, items) {
  const urls = [];
  for (const it of items || []) {
    if (keyOf(it) === key && TRIGGER_FOR[it.category] && it.url) urls.push(it.url);
  }
  return [...new Set(urls)];
}

export function isHidden(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// Hides (snapshot of the current signature) or restores. Mutates `map`; returns
// true if the PR is now hidden.
export function toggleHidden(map, key, items, nowIso = new Date().toISOString()) {
  if (isHidden(map, key)) { delete map[key]; return false; }
  map[key] = { at: nowIso, seen: signatureOf(key, items) };
  return true;
}

// A poll is a **partial sample**, not an inventory: a PR can be absent while
// being perfectly alive (search truncation or eventual consistency, rate-limit,
// a degraded GraphQL chunk, a favorite temporarily removed…). Deleting a key on
// a single absence loses its signature FOR GOOD, and the PR comes back visible
// at the next poll that does return it — that was issue #1. So an absence is
// only ever *dated*, never trusted: we purge after MISSING_TTL_DAYS of
// **uninterrupted** absence, and any reappearance resets the countdown. Long
// enough for any collection artifact to have resolved, short enough that merged
// PRs don't pile up — and a key weighs ~100 bytes anyway.
const MISSING_TTL_DAYS = 30;

// Un-hides a PR as soon as a new event (URL absent from the snapshot) appears,
// and purges the keys absent for longer than the TTL. Mutates `map`; returns
// true if it changed.
export function reconcile(map, entries, items, nowIso = new Date().toISOString()) {
  const present = new Set((entries || []).map(keyOf));
  const now = Date.parse(nowIso);
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!present.has(key)) {
      const since = map[key].missingSince;
      if (!since) { map[key].missingSince = nowIso; changed = true; continue; }
      if (now - Date.parse(since) > MISSING_TTL_DAYS * 86400000) { delete map[key]; changed = true; }
      continue;
    }
    // Back in the poll: the absence was an artifact, the countdown restarts from zero.
    if (map[key].missingSince) { delete map[key].missingSince; changed = true; }
    const seen = new Set(map[key].seen || []);
    const hasNew = signatureOf(key, items).some((u) => !seen.has(u));
    if (hasNew) { delete map[key]; changed = true; }
  }
  return changed;
}

// Selection label of a row = the PR number (e.g. '7004'), as displayed
// in the « PR » column. The user types this number (buffer + Enter) in
// the entrypoint. In case of a duplicate number across repos, the 1st row wins.
export function assignLabels(rows) {
  return rows.map((r) => String(r.number));
}
