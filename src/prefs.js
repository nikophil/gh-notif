import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Persisted UI preferences: `notify` (desktop notifications), `theme` (CSS
// skin), `favorites` (pinned scopes), `activeFav` (displayed favorite) and `sort`
// (sort of the « others » table in --serve, validated by `normalizeSort` on use).
// Modeled on state.js / hidden.js: pure functions + JSON persistence, testable on
// fixtures. Defaults applied on read so that an old/partial file stays valid
// (notifs enabled, auto theme, no favorite, sort not chosen) — so no migration
// is needed when adding a key.
//
// ⚠️ Writing: mutate the in-memory prefs object then re-write it IN FULL
// (`prefs.favorites = …; savePrefs(path, prefs)`). Never
// `savePrefs(path, { favorites })`: that would erase notify/theme.

const DEFAULTS = { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null, ignoredChecks: {} };
const THEMES = ['light', 'dark', 'auto'];

export function prefsPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'prefs-v1.json');
}

// ⚠️ `favorites` is an array: a plain `{ ...DEFAULTS }` would share its
// reference across all calls (a mutation would pollute DEFAULTS). So we always
// copy a fresh instance of it.
const defaults = () => ({ ...DEFAULTS, favorites: [...DEFAULTS.favorites], ignoredChecks: {} });

export function loadPrefs(path) {
  try {
    return { ...defaults(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return defaults();
  }
}

export function savePrefs(path, prefs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2));
}

// Desktop notifs enabled? True by default: only an explicit `notify: false`
// disables them (consistent with loadPrefs defaults).
export function isNotifyEnabled(prefs) {
  return prefs?.notify !== false;
}

// Chosen CSS theme: 'light' | 'dark' | 'auto'. Any unknown/absent value falls
// back to 'auto' (follows the system) — robust against a tampered file.
export function themeOf(prefs) {
  const t = prefs?.theme;
  return THEMES.includes(t) ? t : 'auto';
}

// Blocklist of CI jobs, per repo: { "owner/name": ["check name", …] }.
// Default {} (no repo configured). Robust against a tampered file: any
// non-object value falls back to {}.
export function ignoredChecksOf(prefs) {
  const m = prefs?.ignoredChecks;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// Ignored jobs for a given repo (array; [] if absent or non-array value).
export function ignoredChecksFor(prefs, repo) {
  const v = ignoredChecksOf(prefs)[repo];
  return Array.isArray(v) ? v : [];
}

// Toggles a check in a repo's blocklist (toggle, trimmed name): present → we
// remove it (and **delete the repo key** if its list becomes empty → clean map);
// absent → we add it. Mutates `prefs.ignoredChecks` IN PLACE (created if absent) — cf.
// pitfall §14: the caller then re-writes `prefs` IN FULL via savePrefs. Used by
// POST /ignore-check (checkbox in the web debug view).
export function toggleIgnoredCheck(prefs, repo, name) {
  const n = String(name).trim();
  if (!prefs.ignoredChecks || typeof prefs.ignoredChecks !== 'object' || Array.isArray(prefs.ignoredChecks)) {
    prefs.ignoredChecks = {};
  }
  const list = Array.isArray(prefs.ignoredChecks[repo]) ? prefs.ignoredChecks[repo] : [];
  const next = list.includes(n) ? list.filter((x) => x !== n) : [...list, n];
  if (next.length === 0) delete prefs.ignoredChecks[repo];
  else prefs.ignoredChecks[repo] = next;
  return prefs;
}
