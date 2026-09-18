// GitHub error journal (ARCHITECTURE §35). Every failed `gh` call lands here
// with its code (`GH-<OP>`, the exact call site in github.js), whether the
// caller surfaces it or swallows it — so a colleague can read it later in
// /debug, hours after the fact, and paste it as is. Persisted on disk: the
// service runs with Restart=always, an in-memory list would not survive.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const ERRORS_MAX = 100;

export function errorLogPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'errors.json');
}

// The line a human wants: gh's last stderr line (« HTTP 403: … ») when
// child_process gives it, else the message's last non-empty line.
export function errorLine(err) {
  const text = String(err?.stderr || err?.message || err).trim();
  return text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
}

// GitHub-side failure: a 5xx (« gh: HTTP 502 » on GraphQL, « … (HTTP 502) »
// on REST — both seen), or the GraphQL « Something went wrong while executing
// your query » (an internal error GitHub returns with HTTP 200 and a request
// ID). Nothing to fix on our side — the next poll retries. Flagged in the
// journal and the poll banner so nobody chases it in our code.
export function isServerError(message) {
  return /\bHTTP 5\d\d\b/.test(message) || /Something went wrong while executing your query/i.test(message);
}

// What gh's last line does not say about a GraphQL batch: which aliases failed
// (`errors[].path` → the PR named in the query text, via `err.body` = the
// response gh printed before failing) and how big the batch was. '' when
// there is nothing to add (REST: stderr already carries message + status).
const ALIAS_RE = /(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g;
export function errorDetails(err, args = []) {
  const errors = err?.body?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const prs = new Map();
  for (const m of args.join(' ').matchAll(ALIAS_RE)) prs.set(m[1], `${m[2]}/${m[3]}#${m[4]}`);
  const failed = errors.map((e) => `${e.type ?? 'ERROR'} ${prs.get(e.path?.[0]) ?? e.path?.[0] ?? ''}`.trim());
  const shown = failed.slice(0, 5).join(', ') + (failed.length > 5 ? ` … +${failed.length - 5}` : '');
  return prs.size ? `${shown} — batch of ${prs.size} PR${prs.size > 1 ? 's' : ''}` : shown;
}

// Newest first. A repeat of the newest entry (same code + message) bumps its
// `count` and `at` instead of flooding: a rate-limited poll fails 30
// inspections in one go. `now` is injectable for tests.
export function recordError(entries, err, args = [], now = Date.now()) {
  const code = err?.ghCode ?? 'GH-?';
  const message = errorLine(err);
  const last = entries[0];
  if (last && last.code === code && last.message === message) {
    last.count += 1;
    last.at = now;
    return entries;
  }
  entries.unshift({ at: now, code, message, command: `gh ${args.join(' ')}`.slice(0, 200), count: 1, server: isServerError(message), details: errorDetails(err, args) });
  if (entries.length > ERRORS_MAX) entries.length = ERRORS_MAX;
  return entries;
}

export function loadErrors(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveErrors(path, entries) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

// Journal wired for makeGh: `onError(err, args)` records and persists
// (best-effort — a disk error must never break a poll).
export function openErrorLog(path = errorLogPath()) {
  const entries = loadErrors(path);
  const onError = (err, args) => {
    recordError(entries, err, args);
    try { saveErrors(path, entries); } catch {}
  };
  return { entries, onError };
}
