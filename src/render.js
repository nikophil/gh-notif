// Presentation helpers shared with the web rendering (html.js): CI/state icons,
// relative dates, checks grouped by repo — plus the tiny terminal `favoritesBar`
// used by the `gh notif fav list` subcommand. The notification UI itself is the
// local web page (src/serve.js + src/html.js); there is no terminal table rendering.
import { favoriteLabel } from './favorites.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
};

function resolveOpts(opts) {
  const tty = !!process.stdout.isTTY;
  return {
    color: opts?.color ?? (tty && !process.env.NO_COLOR),
  };
}

function paint(text, code, opts) {
  return opts.color && code ? `${code}${text}${C.reset}` : text;
}

// ── Presentation helpers (shared with html.js) ────────────────────────────
const CI_ICON = { pass: '✅', fail: '❌', pending: '🟡', none: '·' };
export function ciIcon(state) {
  return CI_ICON[state] || '·';
}

// PR status: 📝 draft · 🟢 open · 🟣 merged · 🔴 closed.
const STATE_ICON = { draft: '📝', open: '🟢', merged: '🟣', closed: '🔴' };
export function stateIcon(state) {
  return STATE_ICON[state] || '·';
}

export function relativeDate(iso, nowMs) {
  if (!iso) return '?';
  const ms = nowMs - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (min > 0) return `${min}min ago`;
  return 'just now';
}

// Groups rows by repo → DISTINCT checks (union, order of first appearance).
// Since the blocklist is per repo, ignored-checks config is reasoned per repo,
// not per PR (a same job appears on several PRs). A repo without checks is absent.
// Consumed by the web « Checks by repo » debug section (html.js).
export function checksByRepo(rows) {
  const byRepo = new Map();
  for (const r of rows ?? []) {
    if (!(r.checks?.length)) continue;
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, new Set());
    const set = byRepo.get(r.repo);
    for (const c of r.checks) set.add(c.name);
  }
  return [...byRepo.entries()].map(([repo, names]) => ({ repo, names: [...names] }));
}

// ── Terminal helper for `gh notif fav list` ───────────────────────────────
// Favorites bar: « ⭐ all · [symfony] · zenstruck », the active one in brackets
// and bold. Empty list → empty string. Color auto-disabled outside a TTY.
export function favoritesBar(favorites, active, opts) {
  const o = resolveOpts(opts);
  if (!favorites || favorites.length === 0) return '';
  const cell = (label, on) => (on ? paint(`[${label}]`, C.bold, o) : paint(label, C.dim, o));
  const parts = [cell('⭐ all', !active), ...favorites.map((f) => cell(favoriteLabel(f), f === active))];
  return parts.join(paint(' · ', C.dim, o));
}
