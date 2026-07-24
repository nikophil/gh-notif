// Color & links (disabled outside TTY or if NO_COLOR), building aligned framed
// tables, and display helpers (triggers, CI, relative date, diff).
import { isReady } from './approvals.js';
import { favoriteLabel } from './favorites.js';

const REPO_MAX = 26;
const TITLE_MAX = 46;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m',
  green: '\x1b[32m', red: '\x1b[31m',
};

function resolveOpts(opts) {
  const tty = !!process.stdout.isTTY;
  return {
    color: opts?.color ?? (tty && !process.env.NO_COLOR),
    hyperlinks: opts?.hyperlinks ?? tty,
    now: opts?.now ?? Date.now(),
    showHidden: !!opts?.showHidden,
    hiddenFlags: opts?.hiddenFlags ?? [],
  };
}

function paint(text, code, opts) {
  return opts.color && code ? `${code}${text}${C.reset}` : text;
}

export function hyperlink(url, text, opts) {
  if (!opts.hyperlinks || !url) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// ── Display width ────────────────────────────────────────────────────────
// Counts 2 columns for wide emojis, 0 for variation selectors (U+FE0F). A base
// immediately followed by U+FE0F (emoji presentation, e.g. ↩️) therefore counts
// 2. Box-drawing and the « − » sign stay at 1.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
    (cp >= 0x2600 && cp <= 0x27bf) ||  // miscellaneous symbols + dingbats (✅ ❌ …)
    (cp >= 0x1f000 && cp <= 0x1faff)   // emoji planes (🔍 💬 🟩 🟥 🟡 …)
  );
}

export function displayWidth(text) {
  const chars = [...text];
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue;                 // variation selector: 0
    const next = chars[i + 1] ? chars[i + 1].codePointAt(0) : 0;
    if (next === 0xfe0f) { w += 2; continue; }                 // base + VS16 → wide emoji
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

export function truncate(text, max) {
  if (displayWidth(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

// ── Presentation helpers ─────────────────────────────────────────────────
const TRIGGER_ORDER = ['review', 'mention', 'reply', 'comment'];
const TRIGGER_ICON = {
  review: '🔍',
  mention: '💬',
  reply: '↩️',
  comment: '🗨️', // U+1F5E8 + U+FE0F: without the selector, text presentation (width 1) → misalignment
};

// Emojis only (space to save room). Legend: 🔍 review · 💬 mention · ↩️ reply
// · 🗨 comment (cf. README).
export function triggersLabel(keys) {
  return TRIGGER_ORDER.filter((k) => keys.includes(k)).map((k) => TRIGGER_ICON[k]).join(' ');
}

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

// Returns { text, render(opts) }: `text` (raw) is used for width computation;
// `render` colors +additions green / −deletions red (same visible width).
export function diffStat(additions, deletions) {
  const a = additions || 0;
  const d = deletions || 0;
  const text = `+${a} −${d}`;
  const render = (opts) => `${paint('+' + a, C.green, opts)} ${paint('−' + d, C.red, opts)}`;
  return { text, render };
}

// ── Building a framed table ───────────────────────────────────────────────
// columns: [{ header, max? }]
// rows: [[cell, ...]] where cell = { text, url?, color?, render?(opts) }
//   - `text` is always the raw text used for width/truncation
//   - `render` (optional, non-capped columns) provides a decorated rendering with
//     the same visible width as `text`
function buildTable(columns, rows, opts) {
  const widths = columns.map((col, i) => {
    const natural = Math.max(displayWidth(col.header), ...rows.map((r) => displayWidth(r[i].text)), 0);
    return col.max ? Math.min(natural, col.max) : natural;
  });

  const bar = (ch) => paint(ch, C.dim, opts);
  const border = (l, m, r) => paint(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r, C.dim, opts);

  const renderRow = (cells, isHeader) =>
    bar('│') +
    cells
      .map((cell, i) => {
        const plain = truncate(cell.text, widths[i]);
        const pad = ' '.repeat(Math.max(0, widths[i] - displayWidth(plain)));
        let shown;
        if (isHeader) shown = paint(plain, C.bold, opts);
        else if (cell.render) shown = cell.render(opts);
        else shown = hyperlink(cell.url, paint(plain, cell.color, opts), opts);
        return ` ${shown}${pad} `;
      })
      .join(bar('│')) +
    bar('│');

  return [
    border('┌', '┬', '┐'),
    renderRow(columns.map((c) => ({ text: c.header })), true),
    border('├', '┼', '┤'),
    ...rows.map((r) => renderRow(r, false)),
    border('└', '┴', '┘'),
  ].join('\n');
}

function mineTable(rows, opts) {
  const columns = [
    { header: 'Repository', max: REPO_MAX },
    { header: 'PR' },
    { header: 'Title', max: TITLE_MAX },
    { header: 'Status' },
    { header: '✅' },
    { header: 'Triggers' },
    { header: 'CI' },
  ];
  const cells = rows.map((r) => [
    { text: r.repo, color: C.cyan, url: r.url },
    { text: `#${r.number}`, color: C.yellow, url: r.url },
    { text: r.title, url: r.url },
    { text: stateIcon(r.state) },
    { text: approvalsText(r), color: C.green },
    { text: triggersLabel(r.triggers) },
    { text: ciIcon(r.ci) },
  ]);
  return buildTable(columns, cells, opts);
}

// « approvals » cell of my PRs: counter, suffixed with 🎉 when the PR is OPEN
// and reaches the threshold (« ready to merge »). `·` if no approval.
function approvalsText(r) {
  if (!r.approvals) return '·';
  const ready = r.state === 'open' && isReady(r.approvals);
  return ready ? `${r.approvals} 🎉` : String(r.approvals);
}

function othersTable(rows, opts) {
  // 🙈 marker column at the head, only if there is at least one hidden PR to
  // show (otherwise, no empty column). Selection is done by PR number.
  const withMarker = opts.hiddenFlags.some(Boolean);
  const columns = [
    ...(withMarker ? [{ header: '' }] : []),
    { header: 'Repository', max: REPO_MAX },
    { header: 'PR' },
    { header: 'Title', max: TITLE_MAX },
    { header: 'Author' },
    { header: 'Opened' },
    { header: 'Diff' },
    { header: 'Status' },
    { header: '✅' },
    { header: 'Triggers' },
    { header: 'CI' },
  ];
  const cells = rows.map((r, i) => {
    const diff = diffStat(r.additions, r.deletions);
    const isHid = !!opts.hiddenFlags[i];
    const marker = isHid ? '🙈' : '';
    const col = (color) => (isHid ? C.dim : color); // hidden rows: greyed out
    const row = [
      { text: r.repo, color: col(C.cyan), url: r.url },
      { text: `#${r.number}`, color: col(C.yellow), url: r.url },
      { text: r.title, color: col(undefined), url: r.url },
      { text: r.author ? `@${r.author}` : '?', color: col(C.magenta) },
      { text: relativeDate(r.createdAt, opts.now), color: C.dim },
      { text: diff.text, render: diff.render },
      { text: stateIcon(r.state) },
      { text: r.approvals ? String(r.approvals) : '·', color: col(C.green) },
      { text: triggersLabel(r.triggers) },
      { text: ciIcon(r.ci) },
    ];
    return withMarker ? [{ text: marker, color: C.dim }, ...row] : row;
  });
  return buildTable(columns, cells, opts);
}

export function renderList(data, opts) {
  const o = resolveOpts(opts);
  const blocks = [];
  if (data.mine && data.mine.length > 0) {
    const heading = `📥 ${paint('Your open PRs', C.bold, o)} ${paint(`(${data.mine.length})`, C.dim, o)}`;
    blocks.push(`${heading}\n${mineTable(data.mine, o)}`);
  }
  if (data.others && data.others.length > 0) {
    const hiddenInView = o.hiddenFlags.filter(Boolean).length;
    const visible = data.others.length - hiddenInView;
    const hiddenCount = data.hiddenCount ?? hiddenInView;
    const count = hiddenCount > 0
      ? `(${visible}, ${hiddenCount} hidden)`
      : `(${data.others.length})`;
    const heading = `👥 ${paint("Activity on others' PRs", C.bold, o)} ${paint(count, C.dim, o)}`;
    blocks.push(`${heading}\n${othersTable(data.others, o)}`);
  }
  if (blocks.length === 0) return 'Nothing to report ✨\n';
  return blocks.join('\n\n') + '\n';
}

// Favorites bar of terminal mode: « ⭐ all · [mapado] · zenstruck », the active
// one in brackets and bold. Empty list → empty string (nothing shown for those who
// don't use favorites). Rendered OUTSIDE the framed tables: no alignment
// constraint, hence no impact on displayWidth (cf. §5).
export function favoritesBar(favorites, active, opts) {
  const o = resolveOpts(opts);
  if (!favorites || favorites.length === 0) return '';
  const cell = (label, on) => (on ? paint(`[${label}]`, C.bold, o) : paint(label, C.dim, o));
  const parts = [cell('⭐ all', !active), ...favorites.map((f) => cell(favoriteLabel(f), f === active))];
  return parts.join(paint(' · ', C.dim, o));
}

// Terminal dump of the per-thread classification verdict (--debug mode). One line
// per thread: mark (kept → category / dropped → ✗), repo#number, reason, and
// meta (raw GitHub reason + number of comments). Free list (no table).
export function renderDebugText(debug, opts) {
  const o = resolveOpts(opts);
  if (!debug || debug.length === 0) {
    return `🐛 ${paint('Debug — no notification thread', C.dim, o)}\n${checksSectionText(opts)}`;
  }
  const lines = debug.map((d) => {
    const v = d.verdict;
    const mark = v.kept ? paint(`✓ ${v.category}`, C.green, o) : paint('✗ dropped', C.dim, o);
    const meta = paint(`(GH:${d.ghReason}, ${d.commentsCount} comm.)`, C.dim, o);
    return `  ${mark}  ${d.repo}#${d.number}  ${paint('·', C.dim, o)} ${v.reason}  ${meta}`;
  });
  const kept = debug.filter((d) => d.verdict.kept).length;
  const title = `🐛 ${paint('Debug — pipeline verdict', C.bold, o)} ${paint(`(${kept}/${debug.length} kept)`, C.dim, o)}`;
  return `${title}\n${lines.join('\n')}\n${checksSectionText(opts)}`;
}

// Groups rows by repo → DISTINCT checks (union, order of first appearance).
// Since the blocklist is per repo, ignored-checks config is reasoned per repo,
// not per PR (a same job appears on several PRs). A repo without checks is absent.
// Shared by both debug views (terminal `checksSectionText` + web `renderChecksSection`).
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

// « Checks by repo » section of the terminal dump (--debug mode): per repo, the
// DISTINCT set of its jobs (union over its PRs), the ignored ones (repo blocklist)
// suffixed « (ignored) » and greyed out. Helps copy the exact name of a job to put
// in the blocklist. '' if no row (compat). Since a job's state is per PR, it is not
// shown here (config = per repo) — the per-PR verdict stays in the main tables.
function checksSectionText(opts) {
  const o = resolveOpts(opts);
  const groups = checksByRepo(opts?.rows);
  if (groups.length === 0) return '';
  const ignoredChecks = opts?.ignoredChecks ?? {};
  const blocks = groups.map(({ repo, names }) => {
    const blocked = new Set((ignoredChecks[repo] ?? []).map((n) => String(n).trim()));
    const items = names.map((name) => {
      const ign = blocked.has(name);
      const line = `    ${name}${ign ? ' (ignored)' : ''}`;
      return ign ? paint(line, C.dim, o) : line;
    });
    return [`  ${paint(repo, C.bold, o)}`, ...items].join('\n');
  });
  const title = `🔎 ${paint('Checks by repo', C.bold, o)}`;
  return `${title}\n${blocks.join('\n')}\n`;
}
