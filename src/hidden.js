import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TRIGGER_FOR } from './filter.js';

// Persistence + pure logic for hiding others' PRs. The keyboard interaction
// (`h` key, number + Enter) lives in the entrypoint; here, everything is testable.

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

// Un-hides a PR as soon as a new event (URL absent from the snapshot)
// appears, and prunes keys absent from the current entries. Mutates `map`;
// returns true if it changed.
export function reconcile(map, entries, items) {
  const present = new Set((entries || []).map(keyOf));
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!present.has(key)) { delete map[key]; changed = true; continue; }
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
