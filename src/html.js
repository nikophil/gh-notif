// Pure HTML rendering (no I/O) for the local web dashboard (`gh notif`). Reuses
// the presentation helpers exported by render.js (ciIcon, stateIcon, relativeDate,
// checksByRepo): the display logic stays shared, only the HTML formatting lives here.
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
  ['new', '🆕', 'Newly opened (watched repo)'],
  ['activity', '👀', 'Third-party activity (watched repo)'],
];
// Icon-only column headers (cryptic emoji → full label on hover). Keeps the
// narrow columns (approvals/status/triggers) from being widened by their title.
const iconTh = (emoji, label) => `<abbr title="${label}" style="text-decoration:none;cursor:help">${emoji}</abbr>`;
const APPROVALS_TH = iconTh('✅', 'Approvals');
const STATUS_TH = iconTh('🚦', 'Status');
const TRIGGERS_TH = iconTh('⚡', 'Triggers');

// Sort indicator on the active column (▴ asc / ▾ desc).
const SORT_ARROW = { asc: ' ▴', desc: ' ▾' };

// Sortable header: data-sort-key (click delegation, cf. renderShell) +
// indicator if it's the active column. `sort` absent → bare th (compat).
// `table` ('mine') tags the th so the client posts /sort?table=… — the two
// tables carry independent sort states (cf. §15).
function sortableTh(html, key, sort, table = null) {
  if (!sort) return html;
  const active = sort.key === key;
  return {
    attrs: ` data-sort-key="${key}"${table ? ` data-sort-table="${table}"` : ''} title="Sort"`,
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
  '    --accent: #0969da; --success: #1a7f37; --danger: #cf222e; --attention: #9a6700;\n' +
  '    --btn-bg: #f6f8fa; --btn-border: #1f23280f; --btn-hover: #eef1f4; --shadow: 0 1px 0 #1f23280a;';
const DARK_VARS =
  '--canvas: #0d1117; --canvas-subtle: #151b23; --canvas-inset: #010409;\n' +
  '    --fg: #e6edf3; --fg-muted: #9198a1; --border: #3d444d; --border-muted: #3d444db3;\n' +
  '    --accent: #4493f8; --success: #3fb950; --danger: #f85149; --attention: #d29922;\n' +
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
// GitHub « alert » octicon, inline SVG tinted --danger (zero external asset):
// the PR conflicts with its base branch. It rides along in the Status cell
// rather than taking a column of its own — that cell already answers « can this
// PR move? », and an extra column would widen both tables for a rare case.
const CONFLICT_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style="fill:var(--danger)">' +
  '<path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>' +
  '</svg>';

// ⚠️ The state icon is an **emoji** (📝🟢🟣🔴), the conflict one an SVG: no
// `vertical-align` keyword lines those two up, since an emoji carries its own
// metrics and sits lower than the text box. Hence the inline-flex wrapper —
// `align-items:center` is the only thing that centres them on each other.
const stateCell = (state, conflicting = false) => {
  const icon = titled(STATE_LABEL[state] || state || '', stateIcon(state));
  if (!conflicting) return icon;
  return `<span style="display:inline-flex;align-items:center;gap:.2rem">${icon}${titled('Merge conflicts', CONFLICT_ICON)}</span>`;
};
// GitHub check-state octicons (x / dot-fill / check), inline SVG tinted with the
// Primer state colors — the row icons of GitHub's own checks dropdown.
const ciSvg = (path, color) =>
  `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style="fill:var(${color});vertical-align:text-bottom;flex:none">${path}</svg>`;
const CHECK_STATE_ICON = {
  fail: ciSvg('<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"></path>', '--danger'),
  pending: ciSvg('<path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"></path>', '--attention'),
  pass: ciSvg('<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>', '--success'),
};

// GitHub-like wording of the popover group headings (« 2 failing checks »).
const CHECK_GROUP_LABEL = { fail: 'failing', pending: 'pending', pass: 'successful' };
const groupHeading = (state, n) =>
  `${n} ${CHECK_GROUP_LABEL[state]} check${n > 1 ? 's' : ''}`;

// One check line of the popover: state octicon + name linking to the run in a
// new tab (plain text if the run has no URL). An ignored check (repo blocklist,
// §16) is struck/greyed but stays listed in its group — it explains why the
// aggregated verdict may differ from the raw rollup.
function ciCheckLine(c, blocked) {
  const name = c.url ? link(c.url, c.name) : escapeHtml(c.name);
  const ignored = blocked.has(String(c.name).trim());
  return `<li class="ci-check${ignored ? ' ignored' : ''}">${CHECK_STATE_ICON[c.state] || ''} ${ignored ? `<del>${name}</del>` : name}</li>`;
}

// Popover listing the PR's checks grouped à la GitHub (failing first, then
// pending, then successful). Rendered inline (hidden); the client toggles and
// positions it on click (delegation in renderShell — fragments are re-injected
// at every poll, like the copy buttons).
function ciPopover(checks, blocked) {
  const groups = ['fail', 'pending', 'pass']
    .map((state) => ({ state, items: checks.filter((c) => c.state === state) }))
    .filter((g) => g.items.length > 0)
    .map((g) =>
      `<p class="ci-group">${groupHeading(g.state, g.items.length)}</p>`
      + `<ul>${g.items.map((c) => ciCheckLine(c, blocked)).join('')}</ul>`);
  return `<div class="ci-pop" hidden>${groups.join('')}</div>`;
}

// CI cell: plain icon (tooltip) — but as soon as the individual checks are
// known, the icon becomes a button opening the checks popover (every run with
// its link, whatever the verdict — green included). Without check detail
// (none, or older snapshot), nothing to show → plain icon.
const ciCell = (r, ignoredChecks = {}) => {
  const ci = r?.ci;
  const checks = r?.checks ?? [];
  const label = CI_LABEL[ci] || 'CI: none';
  if (checks.length === 0) return titled(label, ciIcon(ci));
  const blocked = new Set((ignoredChecks?.[r.repo] ?? []).map((n) => String(n).trim()));
  return `<span class="ci-wrap"><button class="ci-btn" title="${escapeHtml(label)} — show checks">${ciIcon(ci)}</button>${ciPopover(checks, blocked)}</span>`;
};
const triggersCell = (keys) => {
  const set = new Set(keys || []);
  return TRIGGER_META.filter(([k]) => set.has(k))
    .map(([, icon, label]) => titled(label, icon))
    .join(' ');
};
// GitHub « changes requested » review icon: octicon `file-diff` (the ± glyph),
// inline SVG (zero external asset, like the favicon) tinted with --danger.
const CHANGES_REQUESTED_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style="fill:var(--danger);vertical-align:text-bottom">' +
  '<path d="M8.75 1.75V5h3.25a.75.75 0 0 1 0 1.5H8.75v3.25a.75.75 0 0 1-1.5 0V6.5H4a.75.75 0 0 1 0-1.5h3.25V1.75a.75.75 0 0 1 1.5 0ZM4 13.25a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1-.75-.75Z"></path>' +
  '</svg>';

// `ready` (my open PR & ≥ threshold) adds the 🎉 « ready to merge » badge.
// `changesRequested` (count of reviewers whose latest review requests changes)
// adds the red file-diff icon next to the count — shown even at 0 approvals
// (a request-changes with no approval is exactly what you want to surface).
const approvalsCell = (n, ready = false, changesRequested = 0) => {
  const cr = changesRequested > 0
    ? titled(`${changesRequested} change${changesRequested > 1 ? 's' : ''} requested`, CHANGES_REQUESTED_ICON)
    : '';
  if (!n) return cr || titled('No approval', '·');
  const count = titled(`${n} approval${n > 1 ? 's' : ''}`, String(n));
  const badge = ready ? ` ${titled('Ready to merge', '🎉')}` : '';
  return cr ? `${count}${badge} ${cr}` : `${count}${badge}`;
};

// GitHub « eye » octicon (the Watch icon), inline SVG — the per-favorite
// Normal / « all » mode toggle on the chips (zero external asset).
const EYE_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style="fill:currentColor;display:block">' +
  '<path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"></path>' +
  '</svg>';

// GitHub « copy » octicon, inline SVG (zero external asset, like the favicon).
const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" style="fill:currentColor;vertical-align:middle">' +
  '<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>' +
  '<path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>' +
  '</svg>';

// Copy-to-clipboard button: data-copy carries the raw value (escaped as an
// attribute), the client handles the click by delegation (cf. renderShell).
const copyBtn = (value, label) =>
  `<button class="copy" data-copy="${escapeHtml(value)}" title="${escapeHtml(label)}">${COPY_ICON}</button>`;

// Branch cell: the head ref name in a small GitHub-like chip (truncated, full
// name in the tooltip) linking to the branch tree — on the HEAD repo (a fork
// for external PRs, like on GitHub), falling back on the base repo if the
// fork is gone — + a tiny copy button. Missing branch → empty cell. The ref
// is URL-encoded but its `/` are kept (tree URLs accept them).
const branchCell = (r) => {
  if (!r.branch) return '';
  const repo = r.branchRepo || r.repo;
  const tree = `https://github.com/${repo}/tree/${encodeURIComponent(r.branch).replace(/%2F/gi, '/')}`;
  return `<a href="${escapeHtml(tree)}" target="_blank" rel="noopener">`
    + `<code class="branch" title="${escapeHtml(r.branch)}">${escapeHtml(r.branch)}</code></a>`
    + copyBtn(r.branch, 'Copy branch name');
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

// Relative-date cell (Opened / Updated), with the full label in the tooltip.
const dateCell = (label, iso, now) =>
  titled(`${label} ${relativeDate(iso, now)}`, escapeHtml(relativeDate(iso, now)));

function mineRow(r, now, hidden, ignoredChecks = {}) {
  return tableRow(
    [
      link(r.url, r.repo),
      link(r.url, `#${r.number}`),
      link(r.url, r.title),
      branchCell(r),
      dateCell('Opened', r.createdAt, now),
      dateCell('Updated', r.updatedAt, now),
      diffCell(r.additions, r.deletions),
      stateCell(r.state, r.conflicting),
      approvalsCell(r.approvals, r.state === 'open' && isReady(r.approvals), r.changesRequested),
      triggersCell(r.triggers),
      ciCell(r, ignoredChecks),
      actionButton(r, hidden),
    ],
    hidden ? 'hid' : '',
  );
}

function mineTable(rows, hiddenRows, now, showHidden, sort = null, ignoredChecks = {}) {
  const headers = [
    'Repository', 'PR', 'Title', 'Branch',
    sortableTh('Opened', 'date', sort, 'mine'),
    sortableTh('Updated', 'updated', sort, 'mine'),
    sortableTh('Diff', 'diff', sort, 'mine'),
    sortableTh(STATUS_TH, 'status', sort, 'mine'),
    APPROVALS_TH, TRIGGERS_TH, 'CI', '',
  ];
  const trs = [
    ...rows.map((r) => mineRow(r, now, false, ignoredChecks)),
    ...(showHidden ? hiddenRows.map((r) => mineRow(r, now, true, ignoredChecks)) : []),
  ];
  return table(headers, trs);
}

// Hide (✕) or restore (↩︎) button for a row (mine and others alike).
function actionButton(r, hidden) {
  const key = escapeHtml(`${r.repo}#${r.number}`);
  return hidden
    ? `<button class="act" data-key="${key}" data-act="show" title="Restore">↩︎</button>`
    : `<button class="act" data-key="${key}" data-act="hide" title="Hide">✕</button>`;
}

function otherRow(r, now, hidden, ignoredChecks = {}) {
  return tableRow(
    [
      link(r.url, r.repo),
      link(r.url, `#${r.number}`),
      link(r.url, r.title),
      branchCell(r),
      r.author ? `@${escapeHtml(r.author)}` : '?',
      dateCell('Opened', r.createdAt, now),
      dateCell('Updated', r.updatedAt, now),
      diffCell(r.additions, r.deletions),
      stateCell(r.state, r.conflicting),
      approvalsCell(r.approvals, false, r.changesRequested),
      triggersCell(r.triggers),
      ciCell(r, ignoredChecks),
      actionButton(r, hidden),
    ],
    hidden ? 'hid' : '',
  );
}

function othersTable(others, hiddenRows, now, showHidden, sort = null, ignoredChecks = {}) {
  const headers = [
    'Repository', 'PR', 'Title', 'Branch',
    sortableTh('Author', 'author', sort),
    sortableTh('Opened', 'date', sort),
    sortableTh('Updated', 'updated', sort),
    sortableTh('Diff', 'diff', sort),
    sortableTh(STATUS_TH, 'status', sort),
    sortableTh(APPROVALS_TH, 'approvals', sort),
    TRIGGERS_TH, 'CI', '',
  ];
  const trs = [
    ...others.map((r) => otherRow(r, now, false, ignoredChecks)),
    ...(showHidden ? hiddenRows.map((r) => otherRow(r, now, true, ignoredChecks)) : []),
  ];
  return table(headers, trs);
}

// Watched-issue row (« all » mode): minimal columns — no CI/diff/approvals
// (meaningless for an issue), no hide button in v1. `actor` = who triggered
// the line (opener for 🆕, commenter for 👀).
function issueTableRow(r, now) {
  return tableRow([
    link(r.url, r.repo),
    link(r.url, `#${r.number}`),
    link(r.url, r.title),
    r.actor ? `@${escapeHtml(r.actor)}` : '?',
    dateCell('Opened', r.createdAt, now),
    dateCell('Updated', r.updatedAt, now),
    triggersCell(r.triggers),
  ]);
}

function issuesTable(rows, now) {
  const headers = ['Repository', 'Issue', 'Title', 'Author', 'Opened', 'Updated', TRIGGERS_TH];
  return table(headers, rows.map((r) => issueTableRow(r, now)));
}

// HTML of the two tables (the « fragment » re-fetched in a loop by the page).
// `now` is injectable for deterministic tests (like render.js).
// `showHidden` adds the hidden rows (greyed out, restore button).
// `closedUrl` (optional): external « closed ↗ » link to my closed PRs on
// GitHub, contextualized on the view (computed upstream, cf. closedPRsUrl). If it
// is provided, the « Your PRs » section is rendered even empty (access to history).
// `sort` (optional) = sort state `{key,dir}` of the « others » table — clickable
// headers + indicator; absent → bare th (compat). `sortMine` (optional) = same
// for « Your PRs » (Opened/Updated columns only), independent state.
// `ignoredChecks` (optional) = per-repo blocklist (§16): strikes the ignored
// checks inside the CI popover.
export function renderFragment(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const showHidden = !!opts.showHidden;
  const closedUrl = opts.closedUrl ?? null;
  const sort = opts.sort ?? null;
  const sortMine = opts.sortMine ?? null;
  const ignoredChecks = opts.ignoredChecks ?? {};
  const mine = data?.mine ?? [];
  const hiddenMine = data?.hiddenMine ?? [];
  const hiddenMineCount = data?.hiddenMineCount ?? hiddenMine.length;
  const others = data?.others ?? [];
  const hiddenRows = data?.hidden ?? [];
  const hiddenCount = data?.hiddenCount ?? hiddenRows.length;

  const blocks = [];
  if (mine.length > 0 || closedUrl || (showHidden && hiddenMineCount > 0)) {
    const hist = closedUrl
      ? ` <a class="hist" href="${escapeHtml(closedUrl)}" target="_blank" rel="noopener">closed ↗</a>`
      : '';
    const count =
      hiddenMineCount > 0
        ? `(${mine.length}, ${hiddenMineCount} hidden)`
        : `(${mine.length})`;
    const rows = mine.length > 0 || (showHidden && hiddenMineCount > 0)
      ? mineTable(mine, hiddenMine, now, showHidden, sortMine, ignoredChecks)
      : '';
    blocks.push(`<section><h2>📥 Your open PRs ${count}${hist}</h2>${rows}</section>`);
  }
  if (others.length > 0 || (showHidden && hiddenCount > 0)) {
    const count =
      hiddenCount > 0
        ? `(${others.length}, ${hiddenCount} hidden)`
        : `(${others.length})`;
    blocks.push(
      `<section><h2>👥 Activity on others' PRs ${count}</h2>${othersTable(others, hiddenRows, now, showHidden, sort, ignoredChecks)}</section>`,
    );
  }
  // Watched issues (« all » mode): their own section, rendered only when it has
  // rows — no favorite in « all » mode ⇒ page strictly unchanged (compat).
  const issues = data?.issues ?? [];
  if (issues.length > 0) {
    blocks.push(`<section><h2>📋 Issues (${issues.length})</h2>${issuesTable(issues, now)}</section>`);
  }
  if (blocks.length === 0) return '<p class="empty">Nothing to report ✨</p>';
  return blocks.join('\n');
}

// Block shown as long as the server has not yet fetched any data (1st cold
// poll). The `data-loading` lets the client re-poll quickly until data arrives.
export function renderLoading(scopeLabel = '') {
  // The first collection (union of favorites) can take a few seconds; say so, and
  // name the scope being loaded so a click on a favorite chip doesn't feel inert.
  // `scopeLabel` is user-controlled (a favorite value) → escaped.
  const where = scopeLabel ? ` for ${escapeHtml(scopeLabel)}` : '';
  return `<p class="empty" data-loading="1"><span class="spinner"></span> Loading pull requests${where}… `
    + '<span class="loading-hint">(first fetch, this can take a few seconds)</span></p>';
}

// Complete page served on `/`: HTML shell + inline CSS + JS (no external
// asset). The JS reloads `/fragment` on startup then every `intervalMs`
// (with a countdown), handles the « refresh » button, the « see the
// Favorites bar: « ⭐ all » then one chip per pinned scope, the active one in .on.
// An org shows as `symfony/*`, a repo as `owner/name` (`favoriteLabel`). Each
// chip carries a cross that removes it. With `counts` ({ total, byFav }, one
// `{ mine, others, issues }` triplet per entry — cf. favoriteCounts), a badge
// shows ONE counter per web panel, each with the panel's own icon: 📥 my PRs,
// 👥 activity on others' PRs, 📋 issues (this last one only when non-zero —
// the Issues section itself only renders when non-empty). Empty list → empty
// string (no visual change for whoever doesn't use favorites).
// `adhoc` = a scope has been typed by hand: it drives collection, the favorites
// are therefore out of play → greyed-out bar, without an active chip.
// ⚠️ The values come from user input: escapeHtml everywhere (text AND
// attribute, `data-fav` stays the RAW value), and encodeURIComponent client-side.
export function renderFavorites(favorites = [], active = null, { adhoc = false, counts = null, favModes = null } = {}) {
  if (!favorites || favorites.length === 0) return '';
  const badge = (c) => {
    if (!counts) return '';
    const n = (v) => Number(v) || 0;
    // U+2009 (thin space) between icon and digit; the inter-counter gap is
    // completed in CSS (.fav-n span + span).
    const parts = [
      `<span title="Your open PRs">📥\u2009${n(c?.mine)}</span>`,
      `<span title="Activity on others' PRs">👥\u2009${n(c?.others)}</span>`,
    ];
    if (n(c?.issues) > 0) parts.push(`<span title="Issues">📋\u2009${n(c?.issues)}</span>`);
    return ` <span class="fav-n">(${parts.join(' ')})</span>`;
  };
  const chips = favorites.map((f) => {
    const on = !adhoc && f === active ? ' class="on"' : '';
    // Eye button = Normal / « all » mode toggle (watch everything: issues,
    // third-party PRs). `data-fav-mode` stays the RAW value, like `data-fav`.
    const all = favModes?.[f] === 'all';
    const modeTitle = all
      ? 'All mode: issues & third-party PRs notify — click to go back to normal'
      : 'Normal mode: only what concerns you — click to watch everything (issues, PRs)';
    return `<span class="chip"><button data-fav="${escapeHtml(f)}"${on}>${escapeHtml(favoriteLabel(f))}${badge(counts?.byFav?.[f])}</button>`
      + `<button class="chip-mode${all ? ' all' : ''}" data-fav-mode="${escapeHtml(f)}" title="${modeTitle}">${EYE_ICON}</button>`
      + `<button class="chip-x" data-fav-rm="${escapeHtml(f)}" title="Remove from favorites">×</button></span>`;
  }).join('');
  const allOn = !adhoc && !active ? ' class="on"' : '';
  const hint = adhoc ? ' title="A scope is filtered manually: favorites no longer drive collection"' : '';
  return `<div class="favs${adhoc ? ' adhoc' : ''}"${hint} role="group" aria-label="Favorites">`
    + `<button data-fav=""${allOn} title="All favorites">⭐ all${badge(counts?.total)}</button>${chips}</div>`;
}

// hidden » mode, the hide-by-button, and the org/repo filter. `scopeLabel` pre-fills
// the scope field. The client rhythm is decoupled from the GitHub poll server-side.
export function renderShell({ intervalMs = 10000, scopeLabel = '', notifyEnabled = true, theme = 'auto', favorites = [], activeFav = null, adhoc = false, counts = null, favModes = null } = {}) {
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
  /* First fetch in progress: dim the chips and show a wait cursor so a click
     doesn't feel inert while the snapshot is not ready yet. */
  #favs.loading { opacity: .5; }
  #favs.loading button { cursor: progress; }
  .loading-hint { color: var(--fg-muted); font-weight: 400; }
  .favs { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .favs.adhoc { opacity: .45; }
  .chip { display: inline-flex; }
  .chip > button { border-radius: 6px 0 0 6px; }
  .chip > .chip-x { border-radius: 0 6px 6px 0; margin-left: -1px; padding: .3rem .45rem;
                    color: var(--fg-muted); }
  .chip > .chip-x:hover { background: var(--danger); border-color: var(--danger); color: #fff; }
  /* Eye = Normal / « all » mode toggle: discreet (muted, revealed on hover),
     tinted accent when the favorite watches everything. */
  .chip > .chip-mode { border-radius: 0; margin-left: -1px; padding: .3rem .4rem;
                       color: var(--fg-muted); opacity: .55;
                       display: inline-flex; align-items: center; }
  .chip:hover > .chip-mode, .chip > .chip-mode.all { opacity: 1; }
  .chip > .chip-mode.all { color: var(--accent); }
  .chip > .chip-mode:hover { color: var(--accent); background: var(--btn-hover); }
  .chip > button.on { position: relative; z-index: 1; }
  /* « (n) » badge = others' activity under this favorite. Readable on the accent
     background when the chip is active. */
  .fav-n { color: var(--fg-muted); font-weight: 400; white-space: nowrap; }
  .fav-n span + span { margin-left: .45em; }
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
  /* Last-clicked row: subtle accent veil so coming back from the PR tab shows
     where you left off. Re-applied by the client after each fragment
     re-injection (innerHTML wipes classes and focus alike). */
  tbody tr.clicked { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  tr.hid td { opacity: .5; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  td a { color: var(--fg); }
  td:nth-child(2) a, td:nth-child(3) a { color: var(--accent); }
  .act { padding: .15rem .5rem; line-height: 1; color: var(--fg-muted); }
  .act:hover { background: var(--danger); border-color: var(--danger); color: #fff; }
  /* Branch copy button, GitHub-like: the bare copy octicon, dimmed until the
     row is hovered, subtle rounded background on hover. The ✓ feedback is
     injected by the client for a second. */
  button.copy { border: 0; background: transparent; box-shadow: none; padding: .15rem .2rem;
                margin-left: .15rem; border-radius: 4px; line-height: 1; font-size: .625rem;
                color: var(--fg-muted); opacity: .4; vertical-align: middle; }
  tbody tr:hover button.copy { opacity: 1; }
  button.copy:hover { color: var(--accent); background: var(--btn-hover); }
  /* Branch chip, GitHub-like (the ref shown on a PR page): tiny monospace on
     an accent-tinted background, truncated, full name in the tooltip. */
  code.branch { display: inline-block; max-width: 9rem; overflow: hidden; text-overflow: ellipsis;
                vertical-align: middle; background: color-mix(in srgb, var(--accent) 10%, transparent);
                color: var(--accent); padding: .1em .35em; border-radius: 4px; font-size: .625rem; }
  /* CI checks popover: the ✗/● icon becomes a discreet button opening a
     GitHub-like panel listing the runs. position:fixed because the sections
     clip their content (overflow:hidden for the rounded corners) — the client
     positions the panel from the button's rect. */
  button.ci-btn { border: 0; background: transparent; box-shadow: none; padding: 0 .1rem;
                  border-radius: 4px; line-height: 1; font-size: inherit; }
  button.ci-btn:hover { background: var(--btn-hover); }
  .ci-pop { position: fixed; z-index: 30; min-width: 16rem; max-width: 26rem; max-height: 60vh;
            overflow-y: auto; background: var(--canvas); border: 1px solid var(--border);
            border-radius: 6px; box-shadow: 0 8px 24px rgba(1,4,9,.3); padding: .3rem 0;
            font-size: .75rem; font-weight: 400; text-align: left; }
  .ci-pop .ci-group { margin: 0; padding: .3rem .75rem .1rem; color: var(--fg-muted); font-weight: 600; }
  .ci-pop ul { list-style: none; margin: 0; padding: 0; }
  .ci-pop .ci-check { display: flex; align-items: center; gap: .45rem; padding: .25rem .75rem;
                      white-space: nowrap; max-width: 26rem; overflow: hidden; text-overflow: ellipsis; }
  .ci-pop .ci-check:hover { background: var(--canvas-subtle); }
  .ci-pop .ci-check a { color: var(--fg); }
  .ci-pop .ci-check a:hover { color: var(--accent); text-decoration: none; }
  .ci-pop .ci-check.ignored { opacity: .5; }
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
      <input id="scope" placeholder="org or owner/repo" autocomplete="off" value="${escapeHtml(scopeLabel)}">
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
    <a id="github-link" href="https://github.com/notifications" target="_blank" rel="noopener" title="Open GitHub notifications">📬</a>
    <a id="debug-link" href="/debug" title="Debug: pipeline verdict">🐛</a>
  </div>
  <div id="fav-err" class="fav-err"></div>
  <div id="favs">${renderFavorites(favorites, activeFav, { adhoc, counts, favModes })}</div>
</header>
<main id="content"></main>
<script>
  var INTERVAL = ${Number(intervalMs)};
  var content = document.getElementById('content');
  var stamp = document.getElementById('stamp');
  var scopeInput = document.getElementById('scope');
  // Browsers restore user-typed form values on reload/session restore, which can
  // resurrect a long-gone ad-hoc scope after a server restart. defaultValue IS the
  // server-rendered state (the value="" attribute) → force it back on boot.
  scopeInput.value = scopeInput.defaultValue;
  var favs = document.getElementById('favs');
  var toggleBtn = document.getElementById('toggle-hidden');
  var showHidden = false;
  var left = INTERVAL / 1000;

  // CI checks popover: one open at a time; closed on outside click, Escape,
  // or fragment re-injection (the node would be detached anyway).
  var openPop = null;
  function closeCiPop() { if (openPop) { openPop.hidden = true; openPop = null; } }
  document.addEventListener('click', function (e) {
    if (openPop && !e.target.closest('.ci-pop') && !e.target.closest('button.ci-btn')) closeCiPop();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCiPop(); });

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
  // Last-clicked row: kept across fragment re-injections (innerHTML wipes it)
  // and page reloads (sessionStorage) so the row stays marked when coming back
  // from the PR tab. Keyed by the link href (unique per row).
  var lastClicked = sessionStorage.getItem('ghn-last-clicked');
  function markLastClicked() {
    if (!lastClicked) return;
    var prev = content.querySelector('tr.clicked');
    if (prev) prev.classList.remove('clicked');
    var links = content.getElementsByTagName('a');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('href') !== lastClicked) continue;
      var tr = links[i].closest('tbody tr');
      if (tr) { tr.classList.add('clicked'); return; }
    }
  }
  function setContent(html, updatedAt) {
    closeCiPop();
    content.innerHTML = html;
    markLastClicked();
    // « upd » = the time of the REAL GitHub poll (updatedAt of the server
    // snapshot), not the display time — otherwise a ctrl+R claims an update it
    // didn't make. The counter is aligned on the estimated next server poll
    // (updatedAt + INTERVAL), clamped: never < 5 s (server behind/backoff
    // → we re-probe quickly, 0 GitHub call) nor > INTERVAL.
    var t = updatedAt || Date.now();
    left = Math.max(5, Math.min(INTERVAL / 1000, Math.round((t + INTERVAL - Date.now()) / 1000) + 2));
    stamp.classList.remove('offline');
    stamp.textContent = 'upd ' + new Date(t).toLocaleTimeString('en-US');
    // Server not ready yet (1st poll in progress) → we re-poll quickly and dim
    // the favorites bar so a click on a chip doesn't feel inert until data lands.
    var loading = !!content.querySelector('[data-loading]');
    favs.classList.toggle('loading', loading);
    if (loading) left = 1;
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
  function applyScope() {
    act('/scope', 'value=' + encodeURIComponent(scopeInput.value.trim()));
  }
  document.getElementById('scope-apply').addEventListener('click', applyScope);
  // Enter while focused in the scope field filters, like the Filter button.
  scopeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); applyScope(); }
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
    // Eye button: toggles the favorite's Normal / « all » mode; the server
    // refreshes in the background (like /fav/add) → probe until the data lands.
    var md = e.target.closest('[data-fav-mode]');
    if (md) { act('/fav/mode', 'value=' + encodeURIComponent(md.getAttribute('data-fav-mode'))).then(function (d) { if (d) chaseFresh(d.updatedAt, 8); }); return; }
    var sel = e.target.closest('[data-fav]');
    // Selecting a favorite leaves ad-hoc mode: clear the manual scope field too.
    if (sel) { scopeInput.value = ''; act('/fav', 'value=' + encodeURIComponent(sel.getAttribute('data-fav'))); }
  });
  // Copy to the clipboard, with a fallback (execCommand) when the Clipboard
  // API is unavailable (page served over plain http on a non-localhost host).
  function copyText(v) {
    if (navigator.clipboard) return navigator.clipboard.writeText(v);
    var ta = document.createElement('textarea');
    ta.value = v; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    return Promise.resolve();
  }
  // Any row link (PR, title, branch…): remember it and mark its row — no
  // return, the link opens normally in its new tab.
  function rememberClick(e) {
    var lk = e.target.closest('a[href]');
    if (lk && lk.closest('tbody tr')) {
      lastClicked = lk.getAttribute('href');
      sessionStorage.setItem('ghn-last-clicked', lastClicked);
      markLastClicked();
    }
  }
  // Middle-click (open in a background tab) fires auxclick, not click.
  content.addEventListener('auxclick', function (e) { if (e.button === 1) rememberClick(e); });
  content.addEventListener('click', function (e) {
    rememberClick(e);
    // Copy button (branch name / PR number): ✓ feedback for a second. The
    // fragment may be re-injected meanwhile — the stale button just vanishes.
    var cp = e.target.closest('button.copy');
    if (cp) {
      copyText(cp.getAttribute('data-copy')).then(function () {
        var old = cp.innerHTML;
        cp.innerHTML = '✓';
        setTimeout(function () { cp.innerHTML = old; }, 1000);
      }).catch(function () {});
      return;
    }
    // CI popover: the ✗/● button toggles the checks panel of its row. The
    // panel is position:fixed (sections clip their overflow) → positioned from
    // the button's rect, clamped inside the viewport.
    var cib = e.target.closest('button.ci-btn');
    if (cib) {
      var pop = cib.nextElementSibling;
      var wasOpen = (pop === openPop);
      closeCiPop();
      if (!wasOpen && pop) {
        pop.hidden = false;
        var rect = cib.getBoundingClientRect();
        pop.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - pop.offsetHeight - 8)) + 'px';
        pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
        openPop = pop;
      }
      return;
    }
    // Sort: click on a sortable header. data-sort-table ('mine') targets the
    // « Your PRs » sort state; without it, the « others » one.
    var th = e.target.closest('th[data-sort-key]');
    if (th) {
      var sq = 'key=' + encodeURIComponent(th.getAttribute('data-sort-key'));
      var tbl = th.getAttribute('data-sort-table');
      if (tbl) sq += '&table=' + encodeURIComponent(tbl);
      act('/sort', sq);
      return;
    }
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
