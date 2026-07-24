import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export function statePath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  // v2: dedup by event URL (no longer by thread/updated_at). New file name so
  // that an old database does not cause a flood when upgrading to v2.
  return join(base, 'gh-notif', 'seen-v2.json');
}

export function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// Dedup by the precise event URL (comment URL, or PR URL for a review request).
// Insensitive to `updated_at` bumps of the thread caused by others' activity
// → we do not re-notify for the same event.
export function isNew(state, item) {
  return !(item.url in state);
}

export function markSeen(state, item) {
  state[item.url] = item.updatedAt;
}
