// Pure HTML rendering (no I/O) for the `gh notif --serve` mode. Reuses the
// presentation helpers already exported by render.js (triggersLabel, ciIcon,
// stateIcon, relativeDate): only the formatting (terminal vs HTML) differs,
// the display logic stays shared.
import { ciIcon, stateIcon, relativeDate, checksByRepo } from './render.js';
import { isReady } from './approvals.js';
import { favoriteLabel } from './favorites.js';

// Labels shown on hover (title="") of the icons — they give the meaning.
const STATE_LABEL = { draft: 'Draft', open: 'Open', merged: 'Merged', closed: 'Closed' };
const CI_LABEL = { pass: 'CI: success', fail: 'CI: failure', pending: 'CI: running', none: 'CI: none' };
// Order + meaning of the triggers (same emojis as render.js).
const TRIGGER_META = [
  ['review', '🔍', 'Review requested'],
  ['mention', '💬', 'Mention'],
  ['reply', '↩️', 'Reply to your thread'],
  ['comment', '🗨️', 'Comment on your PR'],
];
// Header of the « approvals » column (cryptic icon → title on hover).
const APPROVALS_TH = '<abbr title="Approvals" style="text-decoration:none;cursor:help">✅</abbr>';

// Sort indicator on the active column (▴ asc / ▾ desc).
const SORT_ARROW = { asc: ' ▴', desc: ' ▾' };

// Sortable header: data-sort-key (click delegation, cf. renderShell) +
// indicator if it's the active column. `sort` absent → bare th (compat).
function sortableTh(html, key, sort) {
  if (!sort) return html;
  const active = sort.key === key;
  return {
    attrs: ` data-sort-key="${key}" title="Sort"`,
    html: active ? `${html}${SORT_ARROW[sort.dir] ?? ''}` : html,
    active, // current sort column → marked in the colgroup (cf. table)
  };
}

// Favicon: the GitHub logo (mark) embedded as an SVG data-URI (zero external
// asset, like the rest of the pages). Theme-aware via a media query internal to
// the SVG — dark mark on a light tab, light on a dark tab. ⚠️ The `#` of the
// colors must be encoded `%23` in a data-URI (otherwise interpreted as a fragment).
const FAVICON =
  '<link rel="icon" href="data:image/svg+xml,' +
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
  "<style>path{fill:%231f2328}@media(prefers-color-scheme:dark){path{fill:%23e6edf3}}</style>" +
  "<path d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z'/>" +
  '</svg>">';

// GitHub Primer color variables, single source reused for the 4 theme cases
// (auto/system, auto/dark, forced light, forced dark) without tripling them.
const LIGHT_VARS =
  '--canvas: #ffffff; --canvas-subtle: #f6f8fa; --canvas-inset: #f6f8fa;\n' +
  '    --fg: #1f2328; --fg-muted: #59636e; --border: #d1d9e0; --border-muted: #d1d9e0b3;\n' +
  '    --accent: #0969da; --success: #1a7f37; --danger: #cf222e;\n' +
  '    --btn-bg: #f6f8fa; --btn-border: #1f23280f; --btn-hover: #eef1f4; --shadow: 0 1px 0 #1f23280a;';
const DARK_VARS =
  '--canvas: #0d1117; --canvas-subtle: #151b23; --canvas-inset: #010409;\n' +
  '    --fg: #e6edf3; --fg-muted: #9198a1; --border: #3d444d; --border-muted: #3d444db3;\n' +
  '    --accent: #4493f8; --success: #3fb950; --danger: #f85149;\n' +
  '    --btn-bg: #212830; --btn-border: #f0f6fc1a; --btn-hover: #2a313c; --shadow: 0 0 transparent;';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escapes any data coming from GitHub (title, repo, author, url) before
// injecting it into the page. Indispensable: a PR title can contain
// `<`, `&`, `"`… (correctness + anti-injection).
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// Links in a new tab (target=_blank), with rel=noopener (security).
const link = (url, text) =>
  `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;

const diffCell = (additions, deletions) =>
  `<span class="add">+${additions || 0}</span> <span class="del">−${deletions || 0}</span>`;

// « icon » cells with an explanatory title="" on hover.
const titled = (title, content) => `<span title="${escapeHtml(title)}">${content}</span>`;
const stateCell = (state) => titled(STATE_LABEL[state] || state || '', stateIcon(state));
const ciCell = (ci) => titled(CI_LABEL[ci] || 'CI: none', ciIcon(ci));
const triggersCell = (keys) => {
  const set = new Set(keys || []);
  return TRIGGER_META.filter(([k]) => set.has(k))
    .map(([, icon, label]) => titled(label, icon))
    .join(' ');
};
// `ready` (my open PR & ≥ threshold) adds the 🎉 « ready to merge » badge.
const approvalsCell = (n, ready = false) => {
  if (!n) return titled('No approval', '·');
  const count = titled(`${n} approval${n > 1 ? 's' : ''}`, String(n));
  return ready ? `${count} ${titled('Ready to merge', '🎉')}` : count;
};

const tableRow = (cells, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

// A header is either a string (bare th), or { html, attrs } (sortable th —
// attrs carries data-sort-key for click delegation on the client side).
// If a header is `active` (current sort column), a <colgroup> marks the
// matching <col>: the index comes from the same `headers` array as the th,
// so it cannot get out of sync. A <col> background is painted UNDER that of
// the rows → the hover and the opacity of hidden rows stay readable on top.
function table(headers, rows) {
  const colgroup = headers.some((h) => h?.active)
    ? `<colgroup>${headers.map((h) => (h?.active ? '<col class="sorted">' : '<col>')).join('')}</colgroup>`
    : '';
  const head = `<thead><tr>${headers
    .map((h) => (typeof h === 'string' ? `<th>${h}</th>` : `<th${h.attrs}>${h.html}</th>`))
    .join('')}</tr></thead>`;
  const body = `<tbody>${rows.join('')}</tbody>`;
  return `<table>${colgroup}${head}${body}</table>`;
}

function mineTable(rows) {
  const headers = ['Repository', 'PR', 'Title', 'Status', APPROVALS_TH, 'Triggers', 'CI'];
  const trs = rows.map((r) =>
    tableRow([
      link(r.url, r.repo),
      link(r.url, `#${r.number}`),
      link(r.url, r.title),
      stateCell(r.state),
      approvalsCell(r.approvals, r.state === 'open' && isReady(r.approvals)),
      triggersCell(r.triggers),
      ciCell(r.ci),
    ]),
  );
  return table(headers, trs);
}

// Hide (✕) or restore (↩︎) button for an « others » row.
function actionButton(r, hidden) {
  const key = escapeHtml(`${r.repo}#${r.number}`);
  return hidden
    ? `<button class="act" data-key="${key}" data-act="show" title="Restore">↩︎</button>`
    : `<button class="act" data-key="${key}" data-act="hide" title="Hide">✕</button>`;
}

function otherRow(r, now, hidden) {
  return tableRow(
    [
      link(r.url, r.repo),
      link(r.url, `#${r.number}`),
      link(r.url, r.title),
      r.author ? `@${escapeHtml(r.author)}` : '?',
      titled('Opened ' + relativeDate(r.createdAt, now), escapeHtml(relativeDate(r.createdAt, now))),
      diffCell(r.additions, r.deletions),
      stateCell(r.state),
      approvalsCell(r.approvals),
      triggersCell(r.triggers),
      ciCell(r.ci),
      actionButton(r, hidden),
    ],
    hidden ? 'hid' : '',
  );
}

function othersTable(others, hiddenRows, now, showHidden, sort = null) {
  const headers = [
    'Repository', 'PR', 'Title',
    sortableTh('Author', 'author', sort),
    sortableTh('Opened', 'date', sort),
    'Diff', 'Status',
    sortableTh(APPROVALS_TH, 'approvals', sort),
    'Triggers', 'CI', '',
  ];
  const trs = [
    ...others.map((r) => otherRow(r, now, false)),
    ...(showHidden ? hiddenRows.map((r) => otherRow(r, now, true)) : []),
  ];
  return table(headers, trs);
}

// HTML of the two tables (the « fragment » re-fetched in a loop by the page).
// `now` is injectable for deterministic tests (like render.js).
// `showHidden` adds the hidden rows (greyed out, restore button).
// `closedUrl` (optional): external « closed ↗ » link to my closed PRs on
// GitHub, contextualized on the view (computed upstream, cf. closedPRsUrl). If it
// is provided, the « Your PRs » section is rendered even empty (access to history).
// `sort` (optional) = sort state `{key,dir}` of the « others » table — clickable
// headers + indicator; absent → bare th (compat).
export function renderFragment(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const showHidden = !!opts.showHidden;
  const closedUrl = opts.closedUrl ?? null;
  const sort = opts.sort ?? null;
  const mine = data?.mine ?? [];
  const others = data?.others ?? [];
  const hiddenRows = data?.hidden ?? [];
  const hiddenCount = data?.hiddenCount ?? hiddenRows.length;

  const blocks = [];
  if (mine.length > 0 || closedUrl) {
    const hist = closedUrl
      ? ` <a class="hist" href="${escapeHtml(closedUrl)}" target="_blank" rel="noopener">closed ↗</a>`
      : '';
    blocks.push(`<section><h2>📥 Your open PRs (${mine.length})${hist}</h2>${mine.length > 0 ? mineTable(mine) : ''}</section>`);
  }
  if (others.length > 0 || (showHidden && hiddenCount > 0)) {
    const count =
      hiddenCount > 0
        ? `(${others.length}, ${hiddenCount} hidden)`
        : `(${others.length})`;
    blocks.push(
      `<section><h2>👥 Activity on others' PRs ${count}</h2>${othersTable(others, hiddenRows, now, showHidden, sort)}</section>`,
    );
  }
  if (blocks.length === 0) return '<p class="empty">Nothing to report ✨</p>';
  return blocks.join('\n');
}

// Block shown as long as the server has not yet fetched any data (1st cold
// poll). The `data-loading` lets the client re-poll quickly until data arrives.
export function renderLoading() {
  return '<p class="empty" data-loading="1"><span class="spinner"></span> Loading notifications…</p>';
}

// Complete page served on `/`: HTML shell + inline CSS + JS (no external
// asset). The JS reloads `/fragment` on startup then every `intervalMs`
// (with a countdown), handles the « refresh » button, the « see the
// Favorites bar: « ⭐ all » then one chip per pinned scope, the active one in .on.
// An org shows as `mapado/*`, a repo as `owner/name` (`favoriteLabel`). Each
// chip carries a cross that removes it. With `counts` ({ total, byFav }), a badge
// `(n)` = activity on others' PRs for that scope. Empty list → empty string
// (no visual change for whoever doesn't use favorites).
// `adhoc` = a scope has been typed by hand: it drives collection, the favorites
// are therefore out of play → greyed-out bar, without an active chip.
// ⚠️ The values come from user input: escapeHtml everywhere (text AND
// attribute, `data-fav` stays the RAW value), and encodeURIComponent client-side.
export function renderFavorites(favorites = [], active = null, { adhoc = false, counts = null } = {}) {
  if (!favorites || favorites.length === 0) return '';
  const badge = (n) => (counts ? ` <span class="fav-n">(${Number(n) || 0})</span>` : '');
  const chips = favorites.map((f) => {
    const on = !adhoc && f === active ? ' class="on"' : '';
    return `<span class="chip"><button data-fav="${escapeHtml(f)}"${on}>${escapeHtml(favoriteLabel(f))}${badge(counts?.byFav?.[f])}</button>`
      + `<button class="chip-x" data-fav-rm="${escapeHtml(f)}" title="Remove from favorites">×</button></span>`;
  }).join('');
  const allOn = !adhoc && !active ? ' class="on"' : '';
  const hint = adhoc ? ' title="A scope is filtered manually: favorites no longer drive collection"' : '';
  return `<div class="favs${adhoc ? ' adhoc' : ''}"${hint} role="group" aria-label="Favorites">`
    + `<button data-fav=""${allOn} title="All favorites">⭐ all${badge(counts?.total)}</button>${chips}</div>`;
}

// hidden » mode, the hide-by-button, and the org/repo filter. `scopeLabel` pre-fills
// the scope field. The client rhythm is decoupled from the GitHub poll server-side.
export function renderShell({ intervalMs = 10000, scopeLabel = '', notifyEnabled = true, theme = 'auto', favorites = [], activeFav = null, adhoc = false, counts = null } = {}) {
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gh notif</title>
${FAVICON}
<style>
  /* GitHub Primer palette. Light by default; the theme is driven by
     data-theme on <html>: "auto" follows the system (media query), "light"/"dark"
     force it. [data-theme] (specificity 0,1,1) wins over :root in the media
     query → the explicit override always wins. */
  :root { color-scheme: light dark; ${LIGHT_VARS} }
  @media (prefers-color-scheme: dark) {
    :root[data-theme="auto"] { ${DARK_VARS} }
  }
  :root[data-theme="light"] { color-scheme: light; ${LIGHT_VARS} }
  :root[data-theme="dark"] { color-scheme: dark; ${DARK_VARS} }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
         margin: 0; padding: 1rem 1.5rem; background: var(--canvas); color: var(--fg); }
  header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin-bottom: 1.25rem;
           padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 1rem; font-weight: 600; margin: 0; white-space: nowrap; }
  #stamp { font-size: .8rem; color: var(--fg-muted); }
  .spacer { flex: 1; }
  /* Identity (title + timestamp), stuck to the left. */
  .brand { display: flex; align-items: baseline; gap: .5rem; }
  /* Two clusters of controls: « data » (scope/hidden/refresh) then
     « settings » (notifs/theme/debug). Tight inside (gap .4rem = « it goes
     together »), separated from each other by a vertical rule. */
  .group { display: inline-flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .group + .group { margin-left: .5rem; padding-left: .75rem; border-left: 1px solid var(--border); }
  /* Scope + Filter + All merged into a single control (touching borders,
     rounded corners at the ends) to read like a search bar. */
  .input-group { display: inline-flex; }
  .input-group > * { border-radius: 0; margin-left: -1px; }
  .input-group > :first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
  .input-group > :last-child { border-radius: 0 6px 6px 0; }
  .input-group #scope:focus, .input-group button:focus { position: relative; z-index: 1; }
  button, input { font: inherit; }
  button { cursor: pointer; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--fg);
           border-radius: 6px; padding: .3rem .75rem; font-size: .8125rem; font-weight: 500; box-shadow: var(--shadow); }
  button:hover { background: var(--btn-hover); }
  button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  #scope { width: 13rem; padding: .3rem .65rem; border-radius: 6px; font-size: .8125rem;
           border: 1px solid var(--border); background: var(--canvas); color: var(--fg); }
  #scope:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
  /* « desktop notifs » box: label + checkbox aligned in the controls bar. */
  #notify-label { display: flex; align-items: center; gap: .35rem; font-size: .8125rem;
                  color: var(--fg-muted); cursor: pointer; user-select: none; }
  #notify { cursor: pointer; margin: 0; accent-color: var(--accent); }
  /* Theme switcher: buttons stuck together as a « segmented control », the active = .on. */
  .theme-switch { display: inline-flex; }
  .theme-switch button { border-radius: 0; margin-left: -1px; }
  .theme-switch button:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
  .theme-switch button:last-child { border-radius: 0 6px 6px 0; }
  .theme-switch button.on { position: relative; z-index: 1; }
  /* Favorites: « scope + cross » chips stuck together, the active one in .on (same
     color code as the theme switcher). The bar takes the full width under
     the header to stay readable up to 10 favorites. */
  #favs { flex-basis: 100%; }
  .favs { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .favs.adhoc { opacity: .45; }
  .chip { display: inline-flex; }
  .chip > button { border-radius: 6px 0 0 6px; }
  .chip > .chip-x { border-radius: 0 6px 6px 0; margin-left: -1px; padding: .3rem .45rem;
                    color: var(--fg-muted); }
  .chip > .chip-x:hover { background: var(--danger); border-color: var(--danger); color: #fff; }
  .chip > button.on { position: relative; z-index: 1; }
  /* « (n) » badge = others' activity under this favorite. Readable on the accent
     background when the chip is active. */
  .fav-n { color: var(--fg-muted); font-weight: 400; }
  button.on .fav-n { color: #fff; opacity: .85; }
  /* Error message (favorite not found, etc.): full width under the
     controls, hidden when empty. */
  .fav-err { flex-basis: 100%; color: var(--danger); font-size: .8125rem; }
  .fav-err:empty { display: none; }
  /* Section = GitHub « Box »: rounded border, header on a subtle background. */
  section { margin: 0 0 1.5rem; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  h2 { font-size: .875rem; font-weight: 600; margin: 0; padding: .65rem 1rem;
       background: var(--canvas-subtle); border-bottom: 1px solid var(--border); }
  /* Section without a table (« Your PRs (0) » with only the closed link): no
     double rule under the header. */
  section h2:last-child { border-bottom: 0; }
  /* « closed ↗ » link: discreet in the section title. */
  h2 .hist { font-size: .75rem; font-weight: 400; color: var(--fg-muted); margin-left: .35rem; }
  h2 .hist:hover { color: var(--accent); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem 1rem; border-bottom: 1px solid var(--border-muted); white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  th { font-weight: 600; color: var(--fg-muted); font-size: .75rem; }
  th[data-sort-key] { cursor: pointer; user-select: none; }
  th[data-sort-key]:hover { color: var(--accent); }
  /* Active sort column: discreet veil (accent at 6 %), th included. */
  col.sorted { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  /* Title column: absorbs the remaining width and truncates on a single line
     (width:100% + max-width:0 + ellipsis trick on an auto-layout table). */
  td:nth-child(3) { width: 100%; max-width: 0; overflow: hidden; text-overflow: ellipsis; }
  tbody tr:hover { background: var(--canvas-subtle); }
  tr.hid td { opacity: .5; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  td a { color: var(--fg); }
  td:nth-child(2) a, td:nth-child(3) a { color: var(--accent); }
  .act { padding: .15rem .5rem; line-height: 1; color: var(--fg-muted); }
  .act:hover { background: var(--danger); border-color: var(--danger); color: #fff; }
  .spinner { display: inline-block; width: 1em; height: 1em; vertical-align: -2px;
             border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
             animation: ghn-spin .7s linear infinite; }
  @keyframes ghn-spin { to { transform: rotate(360deg); } }
  .add { color: var(--success); font-variant-numeric: tabular-nums; }
  .del { color: var(--danger); font-variant-numeric: tabular-nums; }
  .empty { color: var(--fg-muted); font-size: 1rem; padding: 2rem; text-align: center;
           border: 1px solid var(--border); border-radius: 6px; }
  .offline { color: var(--danger) !important; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>🔔 gh notif</h1>
    <span id="stamp">loading…</span>
  </div>
  <span class="spacer"></span>
  <div class="group" role="group" aria-label="Displayed data">
    <span class="input-group">
      <input id="scope" placeholder="org or owner/repo" value="${escapeHtml(scopeLabel)}">
      <button id="scope-apply" title="Filter on this scope">Filter</button>
      <button id="scope-fav" title="Pin this scope to favorites">⭐</button>
      <button id="scope-all" title="Show all">All</button>
    </span>
    <button id="toggle-hidden" title="Show/hide hidden PRs">🙈 hidden</button>
    <button id="refresh" title="Refresh now">🔄</button>
  </div>
  <div class="group" role="group" aria-label="Settings">
    <label id="notify-label" title="Enable/disable desktop notifications">
      <input type="checkbox" id="notify"${notifyEnabled ? ' checked' : ''}> 🔔 notifs
    </label>
    <span class="theme-switch" role="group" aria-label="Theme">
      <button type="button" data-theme-val="auto"${theme === 'auto' ? ' class="on"' : ''} title="Theme: auto (system)">🌗 auto</button>
      <button type="button" data-theme-val="light"${theme === 'light' ? ' class="on"' : ''} title="Theme: light">☀️ light</button>
      <button type="button" data-theme-val="dark"${theme === 'dark' ? ' class="on"' : ''} title="Theme: dark">🌙 dark</button>
    </span>
    <a id="debug-link" href="/debug" title="Debug: pipeline verdict">🐛</a>
  </div>
  <div id="fav-err" class="fav-err"></div>
  <div id="favs">${renderFavorites(favorites, activeFav, { adhoc, counts })}</div>
</header>
<main id="content"></main>
<script>
  var INTERVAL = ${Number(intervalMs)};
  var content = document.getElementById('content');
  var stamp = document.getElementById('stamp');
  var scopeInput = document.getElementById('scope');
  var favs = document.getElementById('favs');
  var toggleBtn = document.getElementById('toggle-hidden');
  var showHidden = false;
  var left = INTERVAL / 1000;

  function q(extra) {
    var p = [];
    if (showHidden) p.push('hidden=1');
    if (extra) p.push(extra);
    return p.length ? '?' + p.join('&') : '';
  }
  function busy() {
    stamp.classList.remove('offline');
    stamp.innerHTML = '<span class="spinner"></span> updating…';
  }
  function setContent(html, updatedAt) {
    content.innerHTML = html;
    // « upd » = the time of the REAL GitHub poll (updatedAt of the server
    // snapshot), not the display time — otherwise a ctrl+R claims an update it
    // didn't make. The counter is aligned on the estimated next server poll
    // (updatedAt + INTERVAL), clamped: never < 5 s (server behind/backoff
    // → we re-probe quickly, 0 GitHub call) nor > INTERVAL.
    var t = updatedAt || Date.now();
    left = Math.max(5, Math.min(INTERVAL / 1000, Math.round((t + INTERVAL - Date.now()) / 1000) + 2));
    stamp.classList.remove('offline');
    stamp.textContent = 'upd ' + new Date(t).toLocaleTimeString('en-US');
    // Server not ready yet (1st poll in progress) → we re-poll quickly.
    if (content.querySelector('[data-loading]')) left = 1;
  }
  function fail() {
    stamp.classList.add('offline');
    stamp.textContent = 'offline — retrying…';
  }
  // Each response (poll or action) carries {chips, fragment}: the favorites bar
  // lives in the <header> (outside #content), so we inject both. The chip
  // counters thus refresh on EVERY poll, like the tables.
  function inject(d) {
    if (d && typeof d.chips === 'string') favs.innerHTML = d.chips;
    setContent(d.fragment, d.updatedAt);
    return d;
  }
  function load() {
    busy();
    return fetch('/view' + q()).then(function (r) { return r.json(); }).then(inject).catch(fail);
  }
  // POST action → {chips, fragment}. A 4xx (favorite not found, too many favorites)
  // returns a text message shown near the field, without touching the bar.
  function act(path, extra) {
    busy();
    return fetch(path + q(extra), { method: 'POST' })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); });
        return r.json();
      })
      .then(function (d) { inject(d); return d; })
      .catch(showError);
  }
  // Favorite add/remove: the server responds RIGHT AWAY (instant chip)
  // and refreshes the data in the background. We probe /view until the
  // snapshot changes (updatedAt) → the counters and the tables update.
  function chaseFresh(prev, tries) {
    fetch('/view' + q()).then(function (r) { return r.json(); }).then(function (d) {
      inject(d);
      if (d.updatedAt === prev && tries > 0) setTimeout(function () { chaseFresh(prev, tries - 1); }, 700);
    }).catch(function () {});
  }
  function showError(e) {
    stamp.classList.remove('offline');
    stamp.textContent = 'upd ' + new Date().toLocaleTimeString('en-US');
    var el = document.getElementById('fav-err');
    el.textContent = (e && e.message) ? e.message : 'error';
    clearTimeout(el._t); el._t = setTimeout(function () { el.textContent = ''; }, 6000);
  }

  document.getElementById('refresh').addEventListener('click', function () { act('/refresh'); });
  document.getElementById('notify').addEventListener('change', function (e) {
    // Drives the server flag; the box lives in the <header> (outside #content) so
    // it survives the fragment refreshes. We don't replace #content here.
    fetch('/notify?enabled=' + (e.target.checked ? '1' : '0'), { method: 'POST' });
  });
  var themeSwitch = document.querySelector('.theme-switch');
  themeSwitch.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-theme-val]');
    if (!btn) return;
    var val = btn.getAttribute('data-theme-val');
    // Applies right away (no reload), updates the active button, persists.
    document.documentElement.setAttribute('data-theme', val);
    var all = themeSwitch.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === btn);
    fetch('/theme?value=' + encodeURIComponent(val), { method: 'POST' });
  });
  toggleBtn.addEventListener('click', function () {
    showHidden = !showHidden;
    toggleBtn.classList.toggle('on', showHidden);
    load();
  });
  document.getElementById('scope-apply').addEventListener('click', function () {
    act('/scope', 'value=' + encodeURIComponent(scopeInput.value.trim()));
  });
  document.getElementById('scope-all').addEventListener('click', function () {
    scopeInput.value = '';
    act('/scope', 'value=');
  });
  document.getElementById('scope-fav').addEventListener('click', function () {
    var v = scopeInput.value.trim();
    if (!v) return;
    act('/fav/add', 'value=' + encodeURIComponent(v)).then(function (d) {
      // On success only: on a refusal (scope not found), the input stays
      // to let the typo be corrected.
      if (d) { scopeInput.value = ''; chaseFresh(d.updatedAt, 8); }
    });
  });
  // Delegation: the bar is replaced on every action, so we listen on the container.
  favs.addEventListener('click', function (e) {
    var rm = e.target.closest('[data-fav-rm]');
    if (rm) { act('/fav/rm', 'value=' + encodeURIComponent(rm.getAttribute('data-fav-rm'))).then(function (d) { if (d) chaseFresh(d.updatedAt, 8); }); return; }
    var sel = e.target.closest('[data-fav]');
    if (sel) act('/fav', 'value=' + encodeURIComponent(sel.getAttribute('data-fav')));
  });
  content.addEventListener('click', function (e) {
    // Sort: click on a sortable header of the « others » table.
    var th = e.target.closest('th[data-sort-key]');
    if (th) { act('/sort', 'key=' + encodeURIComponent(th.getAttribute('data-sort-key'))); return; }
    var btn = e.target.closest('.act');
    if (!btn) return;
    act('/hide', 'key=' + encodeURIComponent(btn.getAttribute('data-key')));
  });

  setInterval(function () {
    left -= 1;
    if (left <= 0) { load(); return; }
    var base = stamp.textContent.split('  ·  ')[0];
    if (!stamp.classList.contains('offline')) stamp.textContent = base + '  ·  next check in ' + left + 's';
  }, 1000);

  // Page load: shows the snapshot right away (0 GitHub call),
  // then forces a real poll — so a ctrl+R really refreshes the data.
  // The server debounces (shouldRefresh): fresh snapshot → immediate response,
  // spamming ctrl+R doesn't spam GitHub. On failure (server down), fail() has
  // already shown « offline » and d is undefined → we force nothing.
  load().then(function (d) { if (d) act('/refresh'); });
</script>
</body>
</html>`;
}

// Debug HTML fragment: one « pipeline verdict » table per notification
// thread. Any GitHub data (title, repo, reason, raw reason) is
// escaped (anti-injection). `now` accepted for symmetry/determinism.
export function renderDebug(debug, opts = {}) {
  const threads = debug ?? [];
  let head;
  if (threads.length === 0) {
    head = '<p class="empty">No notification thread.</p>';
  } else {
    const kept = threads.filter((d) => d.verdict.kept).length;
    const headers = ['Verdict', 'PR', 'Title', 'Reason', 'GitHub reason', 'Comm.'];
    const trs = threads.map((d) => {
      const v = d.verdict;
      const url = `https://github.com/${d.repo}/pull/${d.number}`;
      const verdict = v.kept
        ? `<span class="ok">✓ ${escapeHtml(v.category)}</span>`
        : '<span class="ko">✗ dropped</span>';
      return tableRow(
        [
          verdict,
          link(url, `${d.repo}#${d.number}`),
          escapeHtml(d.title ?? ''),
          escapeHtml(v.reason),
          `<code>${escapeHtml(d.ghReason)}</code>`,
          String(d.commentsCount ?? 0),
        ],
        v.kept ? '' : 'hid',
      );
    });
    head = `<p class="summary">${kept}/${threads.length} threads kept</p>${table(headers, trs)}`;
  }
  return head + renderChecksSection(opts.rows, opts.ignoredChecks);
}

// « Checks by repo » section of the debug view (web): the blocklist being PER REPO,
// we present, per repo, the DISTINCT set of its jobs (union over its PRs) — not a
// list per PR (which would repeat each job and give the impression of a per-PR
// setting). Each job = a checkbox (checked = ignored across the whole repo, name struck).
// Returns '' if no rows (compat). A job's state being per PR, it is not
// shown here (config = per repo); the per-PR verdict stays in the tables. Every
// check name is escaped (anti-injection, cf. §12).
export function renderChecksSection(rows, ignoredChecks = {}) {
  const groups = checksByRepo(rows);
  if (groups.length === 0) return '';
  const blocks = groups.map(({ repo, names }) => {
    const blocked = new Set((ignoredChecks?.[repo] ?? []).map((n) => String(n).trim()));
    const items = names.map((name) => {
      const ignored = blocked.has(name);
      const label = ignored ? `<del>${escapeHtml(name)}</del>` : escapeHtml(name);
      // Checkbox = toggles the repo blocklist (POST /ignore-check client-side).
      // data-repo/data-name carry the RAW value (escapeHtml for the attributes);
      // the client URL-encodes (encodeURIComponent) at POST time.
      const cb = `<input type="checkbox" class="ig" data-repo="${escapeHtml(repo)}" data-name="${escapeHtml(name)}"${ignored ? ' checked' : ''}>`;
      return `<li class="${ignored ? 'ignored' : ''}"><label>${cb} ${label}</label></li>`;
    }).join('');
    const heading = link(`https://github.com/${repo}`, repo);
    return `<div class="pr-checks"><p>${heading}</p><ul>${items}</ul></div>`;
  });
  return `<h2 class="checks-title">Checks by repo</h2>${blocks.join('')}`;
}

// Standalone `/debug` page (minimal inline CSS, zero external asset): polls
// `/debug-fragment` every `intervalMs`, back link to `/`.
export function renderDebugShell({ intervalMs = 10000 } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gh notif · debug</title>
${FAVICON}
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
         margin: 0; padding: 1rem 1.5rem; background: Canvas; color: CanvasText; }
  header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem;
           padding-bottom: .75rem; border-bottom: 1px solid #8884; }
  header h1 { font-size: 1rem; margin: 0; }
  #stamp { font-size: .8rem; opacity: .7; }
  .spacer { flex: 1; }
  a { color: #4493f8; text-decoration: none; } a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .8rem; border-bottom: 1px solid #8883; white-space: nowrap; }
  th { font-size: .75rem; opacity: .7; }
  td:nth-child(3) { white-space: normal; }
  tr.hid td { opacity: .5; }
  .ok { color: #3fb950; } .ko { opacity: .6; }
  code { background: #8882; padding: .05rem .35rem; border-radius: 4px; font-size: .85em; }
  .summary { opacity: .7; font-size: .85rem; margin: .25rem 0 1rem; }
  .empty { opacity: .6; padding: 2rem; text-align: center; }
  .checks-title { font-size: .95rem; margin: 1.5rem 0 .5rem; }
  .pr-checks { margin: 0 0 .75rem; }
  .pr-checks p { margin: .25rem 0; }
  .pr-checks ul { margin: .1rem 0 .1rem 1rem; padding-left: 1rem; list-style: none; }
  .pr-checks li { white-space: nowrap; }
  .pr-checks li.ignored { opacity: .5; }
  .pr-checks label { cursor: pointer; }
  .pr-checks input.ig { vertical-align: middle; margin-right: .1rem; }
</style>
</head>
<body>
<header>
  <h1>🐛 gh notif · debug</h1>
  <span id="stamp">loading…</span>
  <span class="spacer"></span>
  <a href="/">← back to tables</a>
</header>
<main id="content"><p class="empty">loading…</p></main>
<script>
  var INTERVAL = ${Number(intervalMs)};
  var content = document.getElementById('content');
  var stamp = document.getElementById('stamp');
  function load() {
    fetch('/debug-fragment').then(function (r) { return r.text(); }).then(function (html) {
      content.innerHTML = html;
      stamp.textContent = 'upd ' + new Date().toLocaleTimeString('en-US');
    }).catch(function () { stamp.textContent = 'offline — retrying…'; });
  }
  // A check's checkbox → toggles the repo blocklist (POST /ignore-check),
  // the response is the re-rendered debug fragment that we reinject (boxes + verdicts up to date).
  // DELEGATED handler on #content (persistent) because innerHTML is replaced on every load.
  content.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('ig')) return;
    var qs = 'repo=' + encodeURIComponent(el.dataset.repo) + '&name=' + encodeURIComponent(el.dataset.name);
    fetch('/ignore-check?' + qs, { method: 'POST' }).then(function (r) { return r.text(); }).then(function (html) {
      content.innerHTML = html;
      stamp.textContent = 'upd ' + new Date().toLocaleTimeString('en-US');
    }).catch(function () { stamp.textContent = 'update failed'; });
  });
  load();
  setInterval(load, INTERVAL);
</script>
</body>
</html>`;
}
