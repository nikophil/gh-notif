// Pure HTML rendering (no I/O) for the local web dashboard (`gh notif`). Reuses
// the presentation helpers exported by render.js (ciIcon, stateIcon, relativeDate,
// checksByRepo): the display logic stays shared, only the HTML formatting lives here.
import { ciIcon, stateIcon, relativeDate, durationSince, checksByRepo } from './render.js';
import { isReady } from './approvals.js';
import { favoriteLabel } from './favorites.js';
import { hasStacks } from './sort.js';

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

// Links in a new tab (target=_blank), with rel=noopener (security). `tip`
// puts the full text in the tooltip — for the text cells that a column
// resize can truncate (repo, title; branch has its own chip tooltip).
const link = (url, text, tip = null) =>
  `<a href="${escapeHtml(url)}"${tip ? ` title="${escapeHtml(tip)}"` : ''} target="_blank" rel="noopener">${escapeHtml(text)}</a>`;

const diffTotals = (additions, deletions) =>
  `<span class="add">+${additions || 0}</span> <span class="del">−${deletions || 0}</span>`;

// One line of the diff popover: file type + its own diff. `moreFiles` (> 100
// changed files, cf. github.js) gets a closing « … N files not listed » line.
function diffPopover(types, moreFiles) {
  const lines = types.map((t) =>
    `<li class="diff-type"><span class="diff-ext">${escapeHtml(t.ext)}</span>${diffTotals(t.additions, t.deletions)}</li>`);
  const more = moreFiles > 0
    ? `<li class="diff-more">… ${moreFiles} file${moreFiles > 1 ? 's' : ''} not listed</li>` : '';
  return `<div class="diff-pop" hidden><ul>${lines.join('')}${more}</ul></div>`;
}

// Diff cell: plain +X −Y — but as soon as the per-type breakdown is known
// (row.diffTypes), the numbers themselves become a chrome-less button opening
// a popover listing each file type with its own diff (same mechanics as the
// CI checks popover). The displayed figure stays the raw PR total.
const diffCell = (r) => {
  const types = r?.diffTypes ?? [];
  if (types.length === 0) return diffTotals(r?.additions, r?.deletions);
  return `<span class="diff-wrap"><button class="diff-btn" title="Diff by file type">${diffTotals(r.additions, r.deletions)}</button>${diffPopover(types, r.moreFiles ?? 0)}</span>`;
};

// « icon » cells with an explanatory title="" on hover.
const titled = (title, content) => `<span title="${escapeHtml(title)}">${content}</span>`;
// ⚠️ next to the state icon when the PR conflicts with its base branch. It
// rides along in the Status cell rather than taking a column of its own — that
// cell already answers « can this PR move? », and an extra column would widen
// both tables for a rare case.
// ⚠️ An **emoji**, not an octicon: the state icon is itself an emoji
// (📝🟢🟣🔴) and an inline SVG never lines up next to one — an emoji carries its
// own metrics and sits low in its box, so neither `vertical-align` nor an
// `inline-flex` centring the boxes puts the two glyphs on the same optical
// line. Both tried, both visibly off. Two emojis align for free.
const CONFLICT_ICON = '⚠️';

const stateCell = (state, conflicting = false) =>
  titled(STATE_LABEL[state] || state || '', stateIcon(state))
  + (conflicting ? ` ${titled('Merge conflicts', CONFLICT_ICON)}` : '');
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

// GitHub label colors — the Primer formulas of GitHub's own IssueLabel.
// Light mode: the label color as background, black/white text picked on the
// perceived lightness (threshold 0.453). Dark mode: alpha-tinted background
// (0.18) + text/border lightened toward the 0.6 threshold (a dark color gets a
// readable pastel of the SAME hue; an already-light color stays as-is). Pure
// and exported (tests). `hex` = 6-digit color WITHOUT '#' (the GitHub API
// shape); invalid/absent → null, the chip falls back on the theme's muted
// colors (neutral pill).
export function labelColors(hex) {
  if (!/^[0-9a-f]{6}$/i.test(hex ?? '')) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255; // perceived lightness 0..1
  // rgb → hsl (the dark-mode lightening keeps the hue)
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + 6) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = Math.round(h * 60) % 360;
  }
  const sPct = Math.round(s * 100);
  const lPct = Math.round(l * 100);
  const lightened = Math.min(100, lPct + (lum < 0.6 ? Math.round((0.6 - lum) * 100) : 0));
  return {
    bgLight: `#${hex.toLowerCase()}`,
    fgLight: lum < 0.453 ? '#ffffff' : '#000000',
    bgDark: `rgba(${r},${g},${b},0.18)`,
    fgDark: `hsl(${h},${sPct}%,${lightened}%)`,
    bdDark: `hsla(${h},${sPct}%,${lightened}%,0.3)`,
  };
}

// Labels cell: GitHub-look pill chips. Each chip carries its computed colors
// as inline custom props; the light/dark pick happens in CSS with
// light-dark() — the page already forces `color-scheme` per theme (auto
// included), so the chips follow the theme switcher for free, without
// duplicating the 4 theme selectors. No label → empty cell.
const labelsCell = (labels) => {
  if (!labels?.length) return '';
  const chips = labels.map((l) => {
    const c = labelColors(l.color);
    const style = c
      ? ` style="--lbl-bg-l:${c.bgLight};--lbl-fg-l:${c.fgLight};--lbl-bg-d:${c.bgDark};--lbl-fg-d:${c.fgDark};--lbl-bd-d:${c.bdDark}"`
      : '';
    return `<span class="lbl"${style} title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>`;
  });
  return `<span class="labels">${chips.join('')}</span>`;
};

// The Labels column only renders when at least one row of the table carries a
// label (same spirit as the stacks toggle §20 or the Issues section §18: no
// data → page unchanged). Implemented by adding `labels` to the table's hidden
// columns at render — the gear pref is untouched, the column comes back on its
// own with the first labeled PR.
const dropLabelsIfEmpty = (rows, hiddenCols) =>
  rows.some((r) => r.labels?.length) || hiddenCols.includes('labels')
    ? hiddenCols
    : [...hiddenCols, 'labels'];

// « ⤷ stacks » toggle in a section title: offered ONLY when the table's visible
// rows contain at least one parent/child link (hasStacks) — no stack, no button.
// One global state for both tables (POST /stacks, delegated on #content).
const stacksBtn = (rows, on) =>
  hasStacks(rows)
    ? ` <button class="stacks-toggle${on ? ' on' : ''}" title="Group stacked PRs under their parent">⤷ stacks</button>`
    : '';

// Title cell, stacked-PR aware (sort.js#groupStacks annotations): a child row
// (`stackDepth`) gets a SINGLE fixed ⤷ indent whatever its depth (the grouped
// order already tells the nesting; per-depth offsets just wasted title width);
// a stacked row whose parent is NOT in the table (`orphanBase`) gets a discreet
// « base: … » chip instead. No annotation → the bare link (byte-identical compat).
const titleCell = (r) => {
  const mark = r.stackDepth
    ? `<span class="stack-indent"${r.stackBranched ? ` style="padding-left:${(r.stackDepth - 1) * 14}px"` : ''} title="Stacked on the PR above">↳</span> `
    : '';
  const chip = r.orphanBase
    ? ` <span class="stack-base" title="Stacked PR — its base branch is not in this table">⤷ base: ${escapeHtml(r.orphanBase)}</span>`
    : '';
  return mark + link(r.url, r.title, r.title) + chip;
};

const tableRow = (cells, cls = '', attrs = '') => `<tr${cls ? ` class="${cls}"` : ''}${attrs}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

// Easter egg 🚀: a « mergeable » PR of mine — open, CI green, ≥ 2 approvals, no
// conflict with the base. Derived display state (like the 🎉 badge): the row is
// tagged `data-party="repo#n"` and the CLIENT decides whether it's NEW (vs a
// localStorage set, silent-seeded on first run — same philosophy as §4) and
// fires the confetti — only when the page has focus.
export const isMergeable = (r) =>
  r?.state === 'open' && r?.ci === 'pass' && isReady(r?.approvals) && !r?.conflicting;

// …but the party only fires on a PR that has been in review for MORE than
// 2 business days (a Friday-noon PR only parties from Tuesday noon): merged
// fast = business as usual, no fireworks. Basis = `readyAt` (the draft →
// « ready for review » date, cf. github.js) when known, else `createdAt`;
// no date at all → never (no party on unknown age).
export const PARTY_BUSINESS_DAYS = 2;
export function addBusinessDays(ms, n) {
  const d = new Date(ms);
  for (let added = 0; added < n; ) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.getTime();
}
export function partyWorthy(r, now) {
  const basis = Date.parse(r?.readyAt ?? r?.createdAt ?? '');
  return Number.isFinite(basis) && now >= addBusinessDays(basis, PARTY_BUSINESS_DAYS);
}

// ── Column selector (per-table view, §24) ──────────────────────────────────
// One key per column, ALIGNED with the headers AND cells arrays of each table
// (same single-source guarantee as the colgroup: filtering both through the
// same list cannot desynchronize them). 'act' = the ✕/⚙ column. Title is the
// pivot column (absorbs the leftover width, §23) → never hideable.
const MINE_COL_KEYS = ['repo', 'number', 'title', 'labels', 'branch', 'date', 'review', 'updated', 'diff', 'status', 'approvals', 'triggers', 'ci', 'act'];
const OTHERS_COL_KEYS = ['repo', 'number', 'title', 'labels', 'branch', 'author', 'date', 'review', 'updated', 'diff', 'status', 'approvals', 'triggers', 'ci', 'act'];
const COL_LABELS = {
  repo: 'Repository', number: 'PR', labels: 'Labels', branch: 'Branch', author: 'Author',
  date: 'Opened', review: 'In review', updated: 'Updated', diff: 'Diff', status: 'Status',
  approvals: 'Approvals', triggers: 'Triggers', ci: 'CI', act: 'Hide button',
};
const NEVER_HIDDEN = new Set(['title']);
// GitHub `gear` octicon (16 px inline SVG — the ⚙ text glyph renders tiny and
// inconsistently across fonts).
const GEAR_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style="fill:currentColor;vertical-align:text-bottom">' +
  '<path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"></path></svg>';
const dropHidden = (arr, keys, hidden) =>
  hidden.length ? arr.filter((_, i) => !hidden.includes(keys[i])) : arr;

// Gear button + checkbox popover (one per table, in the section <h2> next to
// the stacks toggle — the header stays reachable even with the ✕ column
// hidden). Same popover mechanics as the CI checks (§17): rendered inline
// hidden, toggled and positioned fixed by the client, one open at a time.
function colsMenu(table, keys, hidden) {
  const rows = keys
    .filter((k) => !NEVER_HIDDEN.has(k))
    .map((k) =>
      `<label class="cols-row"><input type="checkbox" data-cols-table="${table}" data-cols-key="${k}"${hidden.includes(k) ? '' : ' checked'}> ${COL_LABELS[k]}</label>`)
    .join('');
  return `<span class="cols-wrap"><button class="cols-btn" data-cols-table="${table}" title="Choose columns">${GEAR_ICON}</button><div class="cols-pop" hidden>${rows}</div></span>`;
}

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

// Relative-date cell (Opened / Updated); the tooltip carries the precise local date.
const pad2 = (n) => String(n).padStart(2, '0');
const preciseDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const dateCell = (label, iso, now) =>
  titled(`${label} ${iso ? preciseDate(iso) : '?'}`, escapeHtml(relativeDate(iso, now)));

// « In review » cell: bare duration since readyAt (last draft → ready
// transition) falling back on createdAt — the same basis as the easter egg
// (§21). Only an OPEN PR is in review: a draft shows « – » (not yet in
// review), merged and closed an empty cell (no longer relevant).
const reviewCell = (r, now) => {
  if (r.state === 'draft') return '–';
  const iso = r.state === 'open' ? (r.readyAt ?? r.createdAt) : null;
  if (!iso) return '';
  return titled(`In review since ${preciseDate(iso)}`, escapeHtml(durationSince(iso, now)));
};

// Row classes: `hid` (hidden mode) + `stack stack-a|b` (row of a stacked-PRs
// block → tinted background, parent and children alike; the tint alternates
// with the block's stackIndex so adjacent stacks read as separate units).
const rowClass = (r, hidden) =>
  [
    (r.stackDepth || r.inStack) && `stack stack-${(r.stackIndex ?? 0) % 2 ? 'b' : 'a'}`,
    hidden && 'hid',
  ].filter(Boolean).join(' ');

function mineRow(r, now, hidden, ignoredChecks = {}, hiddenCols = []) {
  // Hidden rows are never tagged: no party for a PR you chose not to see.
  // partyWorthy gates on the PR's age in business days (easter egg, not a badge).
  const party = !hidden && isMergeable(r) && partyWorthy(r, now)
    ? ` data-party="${escapeHtml(`${r.repo}#${r.number}`)}"` : '';
  const cells = [
    link(r.url, r.repo, r.repo),
    link(r.url, `#${r.number}`),
    titleCell(r),
    labelsCell(r.labels),
    branchCell(r),
    dateCell('Opened', r.createdAt, now),
    reviewCell(r, now),
    dateCell('Updated', r.updatedAt, now),
    diffCell(r),
    stateCell(r.state, r.conflicting),
    approvalsCell(r.approvals, r.state === 'open' && isReady(r.approvals), r.changesRequested),
    triggersCell(r.triggers),
    ciCell(r, ignoredChecks),
    actionButton(r, hidden),
  ];
  return tableRow(
    dropHidden(cells, MINE_COL_KEYS, hiddenCols),
    rowClass(r, hidden),
    party,
  );
}

function mineTable(rows, hiddenRows, now, showHidden, sort = null, ignoredChecks = {}, hiddenCols = []) {
  hiddenCols = dropLabelsIfEmpty([...rows, ...(showHidden ? hiddenRows : [])], hiddenCols);
  const headers = dropHidden([
    sortableTh('Repository', 'repo', sort, 'mine'),
    sortableTh('PR', 'number', sort, 'mine'),
    sortableTh('Title', 'title', sort, 'mine'),
    sortableTh('Labels', 'labels', sort, 'mine'),
    sortableTh('Branch', 'branch', sort, 'mine'),
    sortableTh('Opened', 'date', sort, 'mine'),
    sortableTh('In review', 'review', sort, 'mine'),
    sortableTh('Updated', 'updated', sort, 'mine'),
    sortableTh('Diff', 'diff', sort, 'mine'),
    sortableTh(STATUS_TH, 'status', sort, 'mine'),
    sortableTh(APPROVALS_TH, 'approvals', sort, 'mine'),
    sortableTh(TRIGGERS_TH, 'triggers', sort, 'mine'),
    sortableTh('CI', 'ci', sort, 'mine'),
    '',
  ], MINE_COL_KEYS, hiddenCols);
  const trs = [
    ...rows.map((r) => mineRow(r, now, false, ignoredChecks, hiddenCols)),
    ...(showHidden ? hiddenRows.map((r) => mineRow(r, now, true, ignoredChecks, hiddenCols)) : []),
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

function otherRow(r, now, hidden, ignoredChecks = {}, hiddenCols = []) {
  const cells = [
    link(r.url, r.repo, r.repo),
    link(r.url, `#${r.number}`),
    titleCell(r),
    labelsCell(r.labels),
    branchCell(r),
    r.author ? titled(`@${r.author}`, `@${escapeHtml(r.author)}`) : '?',
    dateCell('Opened', r.createdAt, now),
    reviewCell(r, now),
    dateCell('Updated', r.updatedAt, now),
    diffCell(r),
    stateCell(r.state, r.conflicting),
    approvalsCell(r.approvals, false, r.changesRequested),
    triggersCell(r.triggers),
    ciCell(r, ignoredChecks),
    actionButton(r, hidden),
  ];
  return tableRow(
    dropHidden(cells, OTHERS_COL_KEYS, hiddenCols),
    rowClass(r, hidden),
  );
}

function othersTable(others, hiddenRows, now, showHidden, sort = null, ignoredChecks = {}, hiddenCols = []) {
  hiddenCols = dropLabelsIfEmpty([...others, ...(showHidden ? hiddenRows : [])], hiddenCols);
  const headers = dropHidden([
    sortableTh('Repository', 'repo', sort),
    sortableTh('PR', 'number', sort),
    sortableTh('Title', 'title', sort),
    sortableTh('Labels', 'labels', sort),
    sortableTh('Branch', 'branch', sort),
    sortableTh('Author', 'author', sort),
    sortableTh('Opened', 'date', sort),
    sortableTh('In review', 'review', sort),
    sortableTh('Updated', 'updated', sort),
    sortableTh('Diff', 'diff', sort),
    sortableTh(STATUS_TH, 'status', sort),
    sortableTh(APPROVALS_TH, 'approvals', sort),
    sortableTh(TRIGGERS_TH, 'triggers', sort),
    sortableTh('CI', 'ci', sort),
    '',
  ], OTHERS_COL_KEYS, hiddenCols);
  const trs = [
    ...others.map((r) => otherRow(r, now, false, ignoredChecks, hiddenCols)),
    ...(showHidden ? hiddenRows.map((r) => otherRow(r, now, true, ignoredChecks, hiddenCols)) : []),
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
// `reviewedUrl` (optional): same contract for the « others » section — external
// « my reviews ↗ » link to the PRs I reviewed (cf. reviewedPRsUrl).
// `sort` (optional) = sort state `{key,dir}` of the « others » table — clickable
// headers + indicator; absent → bare th (compat). `sortMine` (optional) = same
// for « Your PRs » (Opened/Updated columns only), independent state.
// `ignoredChecks` (optional) = per-repo blocklist (§16): strikes the ignored
// checks inside the CI popover.
export function renderFragment(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const showHidden = !!opts.showHidden;
  const closedUrl = opts.closedUrl ?? null;
  const reviewedUrl = opts.reviewedUrl ?? null;
  const sort = opts.sort ?? null;
  const sortMine = opts.sortMine ?? null;
  const ignoredChecks = opts.ignoredChecks ?? {};
  const stacks = !!opts.stacks;
  // `cols` (optional) = per-table hidden columns { mine: [...], others: [...] }
  // (column selector, §24). Absent → no gear button, output strictly unchanged
  // (compat, same contract as `sort`).
  const cols = opts.cols ?? null;
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
      ? mineTable(mine, hiddenMine, now, showHidden, sortMine, ignoredChecks, cols?.mine ?? [])
      : '';
    const gear = cols && rows ? colsMenu('mine', MINE_COL_KEYS, cols.mine ?? []) : '';
    blocks.push(`<section><h2>📥 Your open PRs ${count}${hist}${stacksBtn(mine, stacks)}${gear}</h2>${rows}</section>`);
  }
  if (others.length > 0 || reviewedUrl || (showHidden && hiddenCount > 0)) {
    const hist = reviewedUrl
      ? ` <a class="hist" href="${escapeHtml(reviewedUrl)}" target="_blank" rel="noopener">my reviews ↗</a>`
      : '';
    const count =
      hiddenCount > 0
        ? `(${others.length}, ${hiddenCount} hidden)`
        : `(${others.length})`;
    const rows = others.length > 0 || (showHidden && hiddenCount > 0)
      ? othersTable(others, hiddenRows, now, showHidden, sort, ignoredChecks, cols?.others ?? [])
      : '';
    const gear = cols && rows ? colsMenu('others', OTHERS_COL_KEYS, cols.others ?? []) : '';
    blocks.push(
      `<section><h2>👥 Activity on others' PRs ${count}${hist}${stacksBtn(others, stacks)}${gear}</h2>${rows}</section>`,
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
  /* overflow-x:auto (y stays hidden): a table widened beyond the page by a
     column drag scrolls inside its section instead of being clipped. */
  section { margin: 0 0 1.5rem; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; overflow-x: auto; }
  /* sticky left: the section is the horizontal scrollport (a resized table can
     be wider than the page) and a block h2 only spans the VISIBLE width — without
     this the banner scrolls away with the table and its background stops short
     of the scrolled content's right edge. */
  h2 { font-size: .875rem; font-weight: 600; margin: 0; padding: .65rem 1rem;
       background: var(--canvas-subtle); border-bottom: 1px solid var(--border);
       position: sticky; left: 0;
       display: flex; align-items: center; gap: .35rem; }
  /* Section without a table (« Your PRs (0) » with only the closed link): no
     double rule under the header. */
  section h2:last-child { border-bottom: 0; }
  /* « closed ↗ » link: discreet in the section title. */
  h2 .hist { font-size: .75rem; font-weight: 400; color: var(--fg-muted); }
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
  /* Resizable columns (client-side): an invisible grip on each th right edge,
     a thin accent line on hover/drag. Once a table is resized it switches to
     fixed layout (widths on the colgroup) — every cell then truncates like the
     Title column, which keeps absorbing the leftover width. */
  th { position: relative; }
  .col-grip { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
  .col-grip::after { content: ''; position: absolute; top: 0; right: 0; width: 2px; height: 100%; }
  .col-grip:hover::after, .col-grip.dragging::after { background: var(--accent); }
  table.resized { table-layout: fixed; }
  table.resized th, table.resized td { overflow: hidden; text-overflow: ellipsis; }
  body.col-resizing { cursor: col-resize; user-select: none; }
  /* Stacked-PRs blocks: subtle veil on every row of a stack (parent +
     children) so each block reads as one unit; two alternating tints tell
     adjacent blocks apart. Declared BEFORE tr:hover (same specificity) so the
     hover feedback still wins on top. */
  tbody tr.stack-a { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  tbody tr.stack-b { background: color-mix(in srgb, var(--success) 6%, transparent); }
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
  /* PR labels, GitHub-look pills: each chip carries its Primer-computed colors
     (labelColors) as inline custom props; light-dark() follows the page's
     forced color-scheme, so the 4 theme cases need no extra selector. The
     fallbacks (no/invalid color) give a neutral muted pill. */
  .labels { display: inline-flex; flex-wrap: wrap; gap: 2px; max-width: 11rem; vertical-align: middle; }
  .lbl { display: inline-block; max-width: 10rem; overflow: hidden; text-overflow: ellipsis;
         white-space: nowrap; padding: 0 7px; border-radius: 2em; font-size: .625rem;
         font-weight: 500; line-height: 1.6;
         background: light-dark(var(--lbl-bg-l, var(--canvas-subtle)), var(--lbl-bg-d, var(--canvas-subtle)));
         color: light-dark(var(--lbl-fg-l, var(--fg-muted)), var(--lbl-fg-d, var(--fg-muted)));
         border: 1px solid light-dark(transparent, var(--lbl-bd-d, var(--border-muted))); }
  /* Stacked PRs: ⤷ marker of a child row (indent carried inline, per depth)
     and « base: … » chip of a stacked row whose parent is not in the table —
     both muted and tiny, GitHub-like discretion. */
  .stack-indent { color: var(--fg-muted); }
  /* « ⤷ stacks » toggle in the section titles: tiny GitHub-like chip, accent
     when active (same visual language as the 🙈 hidden toggle, but smaller). */
  /* Right-side group of the section bar: the stacks toggle then the gear.
     margin-left:auto pushes the FIRST present one to the right edge (the ~
     rule cancels it on the gear when the stacks toggle is also there). */
  button.stacks-toggle, h2 .cols-wrap { margin-left: auto; }
  button.stacks-toggle ~ .cols-wrap { margin-left: 0; }
  /* the wrap is a flex item: without this the button inside sits on the
     baseline and the gear rides higher than the stacks chip next to it */
  h2 .cols-wrap { display: inline-flex; align-items: center; }
  button.stacks-toggle { font-size: .625rem; font-weight: 400; color: var(--fg-muted);
                         background: transparent; border: 1px solid var(--border-muted);
                         border-radius: 10px; padding: 0 .5em;
                         vertical-align: middle; box-shadow: none; }
  button.stacks-toggle:hover { color: var(--accent); border-color: var(--accent); }
  button.stacks-toggle.on { color: var(--accent); border-color: var(--accent);
                            background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .stack-base { font-size: .625rem; color: var(--fg-muted); white-space: nowrap;
                border: 1px solid var(--border-muted); border-radius: 10px; padding: 0 .4em; }
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
  /* Per-type diff popover: the +X −Y figures are themselves the button (no
     visible chrome), opening a panel listing each file type with its diff.
     Same fixed positioning as the CI popover (sections clip their overflow). */
  button.diff-btn { border: 0; background: transparent; box-shadow: none; padding: 0 .1rem;
                    border-radius: 4px; line-height: 1; font: inherit; cursor: pointer; }
  button.diff-btn:hover { background: var(--btn-hover); }
  .diff-pop { position: fixed; z-index: 30; min-width: 9rem; max-height: 60vh;
              overflow-y: auto; background: var(--canvas); border: 1px solid var(--border);
              border-radius: 6px; box-shadow: 0 8px 24px rgba(1,4,9,.3); padding: .3rem 0;
              font-size: .75rem; font-weight: 400; text-align: left; }
  .diff-pop ul { list-style: none; margin: 0; padding: 0; }
  .diff-pop .diff-type { display: flex; align-items: center; gap: .6rem; padding: .25rem .75rem;
                         white-space: nowrap; }
  .diff-pop .diff-type:hover { background: var(--canvas-subtle); }
  .diff-pop .diff-ext { flex: 1; color: var(--fg); }
  .diff-pop .diff-more { padding: .25rem .75rem; color: var(--fg-muted); }
  /* Column selector (§24): tiny gear in the ✕-column th, revealed on hover
     (GitHub-discreet), opening a checkbox popover — same fixed positioning as
     the CI popover (the sections clip their overflow). */
  button.cols-btn { border: 0; background: transparent; box-shadow: none; padding: .15rem .3rem;
                    border-radius: 4px; line-height: 1; display: inline-flex; color: var(--fg-muted); }
  button.cols-btn:hover { background: var(--btn-hover); color: var(--accent); }
  .cols-pop { position: fixed; z-index: 30; min-width: 9rem; background: var(--canvas);
              border: 1px solid var(--border); border-radius: 6px;
              box-shadow: 0 8px 24px rgba(1,4,9,.3); padding: .3rem 0;
              font-size: .75rem; font-weight: 400; text-align: left; }
  .cols-pop .cols-row { display: flex; align-items: center; gap: .45rem;
                        padding: .25rem .75rem; white-space: nowrap; cursor: pointer; }
  .cols-pop .cols-row:hover { background: var(--canvas-subtle); }
  .spinner { display: inline-block; width: 1em; height: 1em; vertical-align: -2px;
             border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
             animation: ghn-spin .7s linear infinite; }
  @keyframes ghn-spin { to { transform: rotate(360deg); } }
  .add { color: var(--success); font-variant-numeric: tabular-nums; }
  .del { color: var(--danger); font-variant-numeric: tabular-nums; }
  .empty { color: var(--fg-muted); font-size: 1rem; padding: 2rem; text-align: center;
           border: 1px solid var(--border); border-radius: 6px; }
  .offline { color: var(--danger) !important; }
  /* Easter egg 🚀 (PR freshly mergeable): full-screen confetti canvas (inert,
     removed when the physics dies down), golden shimmer on the celebrated row,
     and a springy « Ship it! » banner. Client-driven (cf. checkParty). */
  .party-canvas { position: fixed; inset: 0; z-index: 50; pointer-events: none; }
  tbody tr.party { animation: ghn-party-row 3s ease-out; }
  @keyframes ghn-party-row {
    0%, 100% { background: transparent; }
    15%, 60% { background: color-mix(in srgb, var(--attention) 22%, transparent); }
  }
  .party-banner { position: fixed; top: 50%; left: 50%; z-index: 51; pointer-events: none;
                  transform: translate(-50%, -50%); background: var(--canvas); border: 1px solid var(--border);
                  border-radius: 12px; box-shadow: 0 8px 24px rgba(1,4,9,.3); padding: 1rem 2rem;
                  font-weight: 600; white-space: nowrap; text-align: center;
                  animation: ghn-party-pop .6s cubic-bezier(.2,1.9,.4,1); }
  @keyframes ghn-party-pop { from { transform: translate(-50%, -50%) scale(.3) rotate(-6deg); opacity: 0; }
                             to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
  .party-banner.out { transition: opacity .5s, transform .5s; opacity: 0;
                      transform: translate(-50%, -50%) translateY(-2rem); }
  .party-banner .party-head { font-size: 2.5rem; font-weight: 800; line-height: 1.2; }
  .party-banner .party-pr { font-weight: 400; font-size: .875rem; color: var(--fg-muted); }
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
  // Column-selector popover: which table's menu is open ('mine'/'others'), so
  // it can be re-opened after each fragment re-injection (checking a box POSTs
  // /cols and replaces #content — without this the menu would close after
  // every single toggle).
  var openColsTable = null;
  var popAnchor = null;
  function closeCiPop() {
    if (openPop) {
      openPop.hidden = true;
      // Undo the <body> reparenting (showPop): back next to its anchor, or
      // dropped if the fragment was re-injected meanwhile (orphan node).
      if (openPop.parentNode === document.body) {
        if (popAnchor && popAnchor.isConnected) popAnchor.after(openPop);
        else openPop.remove();
      }
      openPop = null;
    }
    openColsTable = null; popAnchor = null;
  }
  function showPop(anchor, pop) {
    popAnchor = anchor;
    // Reparent to <body>: an ancestor sticky h2 creates a stacking context
    // that would confine the popover's z-index under the table headers.
    if (pop.parentNode !== document.body) document.body.appendChild(pop);
    pop.hidden = false;
    var rect = anchor.getBoundingClientRect();
    pop.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - pop.offsetHeight - 8)) + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    openPop = pop;
  }
  document.addEventListener('click', function (e) {
    if (openPop && !e.target.closest('.ci-pop, .cols-pop, .diff-pop') && !e.target.closest('button.ci-btn, button.cols-btn, button.diff-btn')) closeCiPop();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCiPop(); });
  // position:fixed popovers don't follow the page: re-anchor them on scroll
  // (capture: the horizontal scroll happens on the sections, not on window).
  document.addEventListener('scroll', function () {
    if (openPop && popAnchor) showPop(popAnchor, openPop);
  }, true);

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
  // ── Easter egg 🚀: party when one of MY PRs becomes mergeable ────────────
  // The server tags the mergeable rows (data-party="repo#n", cf. isMergeable);
  // the client spots the NEW keys vs a localStorage set (silent seed on first
  // run — no burst at feature launch, same philosophy as the server seeds; the
  // list is capped and never pruned on absence: a partial poll must not
  // re-party, same invariant as the hidden reconcile). The animation only
  // plays when the page HAS FOCUS: detected in a background tab, the party is
  // queued and fires when you come back.
  var PARTY_KEY = 'ghn-party-v1';
  var partyQueue = [];
  var partyBusy = false;
  function partySeen() {
    try { var v = JSON.parse(localStorage.getItem(PARTY_KEY)); return Array.isArray(v) ? v : null; }
    catch (e) { return null; }
  }
  function partyMark(list) {
    try { localStorage.setItem(PARTY_KEY, JSON.stringify(list.slice(-200))); } catch (e) {}
  }
  function checkParty() {
    var rows = content.querySelectorAll('tr[data-party]');
    var keys = [], i;
    for (i = 0; i < rows.length; i++) keys.push(rows[i].getAttribute('data-party'));
    var seen = partySeen();
    if (seen === null) { partyMark(keys); return; }
    for (i = 0; i < keys.length; i++) {
      if (seen.indexOf(keys[i]) === -1 && partyQueue.indexOf(keys[i]) === -1) partyQueue.push(keys[i]);
    }
    drainParty();
  }
  function drainParty() {
    if (partyBusy || partyQueue.length === 0 || !document.hasFocus()) return;
    // ONE party for the whole batch: several PRs ready at once → a single
    // banner listing them all, every ready row highlighted together.
    // Re-check seen AT DRAIN TIME, not only at enqueue: another tab may have
    // partied for the same key while it sat queued here (queues are per tab,
    // seen is shared) — replaying the stale queue re-partied the same PR
    // once per open tab (real bug).
    var queued = partyQueue.splice(0, partyQueue.length);
    var seen = partySeen() || [];
    var keys = [];
    for (var i = 0; i < queued.length; i++) {
      if (seen.indexOf(queued[i]) === -1) { seen.push(queued[i]); keys.push(queued[i]); }
    }
    if (keys.length === 0) return;
    partyMark(seen);
    partyBusy = true;
    playParty(keys, function () {
      partyBusy = false;
      // Keys queued while the show played → next batch.
      drainParty();
    });
  }
  window.addEventListener('focus', drainParty);

  // The show: side cannons from EACH ready row, a wobbling 🚀 lifting off from
  // each of them (staggered) with a spark trail, explosion near the top, then
  // — once the last rocket has blown — confetti rain over the whole page.
  // Canvas overlay (pointer-events none), removed when the last particle dies;
  // the celebrated rows shimmer gold meanwhile.
  function playParty(keys, done) {
    var rows = [], all = content.querySelectorAll('tr[data-party]'), i, j;
    for (i = 0; i < all.length; i++) {
      if (keys.indexOf(all[i].getAttribute('data-party')) !== -1) rows.push(all[i]);
    }
    for (i = 0; i < rows.length; i++) {
      rows[i].classList.add('party');
    }
    setTimeout(function () {
      for (var r = 0; r < rows.length; r++) rows[r].classList.remove('party');
    }, 3000);
    // Banner: headline + the list of PRs, one per line (textContent only — the
    // keys come from GitHub data, never injected as HTML).
    var banner = document.createElement('div');
    banner.className = 'party-banner';
    var head = document.createElement('div');
    head.className = 'party-head';
    head.textContent = '🚀 Push to prod! 🎉';
    banner.appendChild(head);
    for (i = 0; i < keys.length; i++) {
      var line = document.createElement('div');
      line.className = 'party-pr';
      line.textContent = keys[i];
      banner.appendChild(line);
    }
    document.body.appendChild(banner);
    setTimeout(function () { banner.classList.add('out'); }, 3800);
    setTimeout(function () { banner.remove(); }, 4400);

    var cv = document.createElement('canvas');
    cv.className = 'party-canvas';
    cv.width = window.innerWidth; cv.height = window.innerHeight;
    document.body.appendChild(cv);
    var cx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var COLORS = ['#0969da', '#1a7f37', '#cf222e', '#9a6700', '#8250df', '#fb8500', '#3fb950'];
    var EMOJI = ['🎉', '🎊', '✅', '🍾', '🦄', '🐙'];
    var parts = [];

    function confetti(x, y, vx, vy, jx, jy) {
      parts.push({
        kind: 'c', x: x, y: y,
        vx: vx + (Math.random() - 0.5) * jx, vy: vy + (Math.random() - 0.5) * jy,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        w: 4 + Math.random() * 5, h: 7 + Math.random() * 5,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        ttl: 140 + Math.random() * 80, sway: Math.random() * Math.PI * 2,
      });
    }
    function emoji(x, y, vx, vy) {
      parts.push({
        kind: 'e', x: x, y: y, vx: vx, vy: vy,
        rot: (Math.random() - 0.5) * 0.6, vr: (Math.random() - 0.5) * 0.1,
        size: 16 + Math.random() * 12, glyph: EMOJI[(Math.random() * EMOJI.length) | 0],
        ttl: 160 + Math.random() * 60, sway: Math.random() * Math.PI * 2,
      });
    }
    function boom(x, y, n) {
      for (var k = 0; k < n; k++) {
        var a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 7;
        confetti(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 2, 0, 0);
      }
      for (var m = 0; m < 10; m++) {
        var a2 = Math.random() * Math.PI * 2, sp2 = 1 + Math.random() * 4;
        emoji(x, y, Math.cos(a2) * sp2, Math.sin(a2) * sp2 - 3);
      }
    }

    // Act 1: two cannons fire inward from each ready row's ends, and a rocket
    // is armed on each row — lift-offs staggered (negative t = countdown) so
    // the fleet doesn't blur into one blob. Origins clamped in the viewport
    // (a row may be scrolled out); no row at all → one rocket, bottom centre.
    var rockets = [];
    for (i = 0; i < rows.length; i++) {
      var rc = rows[i].getBoundingClientRect();
      var rx = (rc.left + rc.right) / 2;
      var ry = Math.max(24, Math.min((rc.top + rc.bottom) / 2, H - 24));
      rockets.push({ ox: rx, x: rx, y: ry, vy: -Math.max(9, H / 80), t: -i * 14, alive: true });
      for (j = 0; j < 25; j++) {
        confetti(Math.max(8, rc.left), ry, 4, -6, 4, 5);
        confetti(Math.min(W - 8, rc.right), ry, -4, -6, 4, 5);
      }
    }
    if (rockets.length === 0) {
      rockets.push({ ox: W / 2, x: W / 2, y: H - 24, vy: -Math.max(9, H / 80), t: 0, alive: true });
    }
    var rocketsLeft = rockets.length;

    function tick() {
      cx.clearRect(0, 0, W, H);
      var anyRocket = false;
      for (var ri = 0; ri < rockets.length; ri++) {
        var rk = rockets[ri];
        if (!rk.alive) continue;
        anyRocket = true;
        rk.t++;
        if (rk.t < 0) continue; // still on the launch pad (staggered lift-off)
        rk.y += rk.vy;
        rk.x = rk.ox + Math.sin(rk.t / 4) * 18;
        for (var s = 0; s < 3; s++) confetti(rk.x, rk.y + 12, 0, 1.5, 3, 2);
        cx.save();
        cx.translate(rk.x, rk.y);
        // The 🚀 glyph points NE → tilt it to face up, wobbling with the flight.
        cx.rotate(Math.sin(rk.t / 4) * 0.25 - Math.PI / 4);
        cx.font = '28px serif';
        cx.textAlign = 'center';
        cx.fillText('🚀', 0, 0);
        cx.restore();
        if (rk.y < Math.max(60, H * 0.12)) {
          rk.alive = false;
          rocketsLeft--;
          boom(rk.x, rk.y, 120);
          // Act 3, once the LAST rocket has blown: confetti rain across the
          // whole top of the page.
          if (rocketsLeft === 0) {
            for (var r2 = 0; r2 < 60; r2++) confetti(Math.random() * W, -10 - Math.random() * 40, 0, 2 + Math.random() * 2, 2, 1);
          }
        }
      }
      for (var j = parts.length - 1; j >= 0; j--) {
        var p = parts[j];
        p.ttl--;
        p.vy += 0.14;
        p.vx *= 0.99;
        p.sway += 0.15;
        p.x += p.vx + Math.sin(p.sway) * 0.8;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.ttl <= 0 || p.y > H + 30) { parts.splice(j, 1); continue; }
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        if (p.kind === 'c') {
          cx.globalAlpha = Math.min(1, p.ttl / 40);
          cx.fillStyle = p.color;
          // Height squeezed by the sway → cheap 3D tumble effect.
          cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * (0.4 + Math.abs(Math.sin(p.sway)) * 0.6));
        } else {
          cx.globalAlpha = Math.min(1, p.ttl / 30);
          cx.font = p.size + 'px serif';
          cx.textAlign = 'center';
          cx.fillText(p.glyph, 0, 0);
        }
        cx.restore();
      }
      if (anyRocket || parts.length > 0) requestAnimationFrame(tick);
      else { cv.remove(); done(); }
    }
    requestAnimationFrame(tick);
  }

  function setContent(html, updatedAt) {
    var reopenCols = openColsTable; // survive the closeCiPop below (re-opened after injection)
    closeCiPop();
    content.innerHTML = html;
    markLastClicked();
    initResize();
    // Re-open the column menu that was open before the injection (fresh node,
    // up-to-date checkboxes) — multi-toggling stays fluid across re-renders.
    if (reopenCols) {
      var reBtn = content.querySelector('button.cols-btn[data-cols-table="' + reopenCols + '"]');
      if (reBtn && reBtn.nextElementSibling) {
        showPop(reBtn, reBtn.nextElementSibling);
        openColsTable = reopenCols;
      }
    }
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
    // Never during the loading placeholder: seeding on an EMPTY page would
    // make every already-mergeable PR party at the next injection.
    if (!loading) checkParty();
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
  // ── Resizable columns (drag on a header edge) ────────────────────────────
  // Client-only display state, like the last-clicked row: #content is
  // re-injected at every poll (innerHTML wipes the grips AND any inline
  // width), so initResize() re-installs both after each injection. Widths
  // persist in localStorage per device (no server round-trip). The Title
  // column keeps its auto « absorb the rest » behavior: shrinking any other
  // column hands the space straight to the titles — the point of the feature.
  var COLW_KEY = 'ghn-colw-v1';
  var TITLE_COL = 2; // stays auto — absorbs whatever the others release
  function loadColw() {
    try { var v = JSON.parse(localStorage.getItem(COLW_KEY)); return v && typeof v === 'object' ? v : {}; }
    catch (e) { return {}; }
  }
  function saveColw() { try { localStorage.setItem(COLW_KEY, JSON.stringify(colw)); } catch (e) {} }
  var colw = loadColw();
  // mine = th tagged data-sort-table; others = sortable th without it. The
  // issues table has no sortable th → no resize (minimal columns, no need).
  function tableIdOf(tbl) {
    if (tbl.querySelector('th[data-sort-table="mine"]')) return 'mine';
    if (tbl.querySelector('th[data-sort-key]')) return 'others';
    return null;
  }
  // The sorted-column colgroup only exists under an active sort — create one
  // otherwise (widths live on the cols, so fixed layout reads them all).
  function colsOf(tbl, n) {
    var cg = tbl.querySelector('colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      for (var i = 0; i < n; i++) cg.appendChild(document.createElement('col'));
      tbl.insertBefore(cg, tbl.firstChild);
    }
    return cg.children;
  }
  function applyWidths(tbl, id, n) {
    var w = colw[id];
    if (!w || w.length !== n) return; // column set changed → stale widths ignored
    var cols = colsOf(tbl, n);
    for (var i = 0; i < n; i++) cols[i].style.width = w[i] == null ? '' : w[i] + 'px';
    tbl.classList.add('resized');
  }
  function initResize() {
    var tables = content.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var tbl = tables[t];
      var id = tableIdOf(tbl);
      if (!id) continue;
      var ths = tbl.querySelectorAll('thead th');
      for (var i = 0; i < ths.length - 1; i++) { // last col (✕ button): no grip
        var g = document.createElement('div');
        g.className = 'col-grip';
        g.setAttribute('data-col', i);
        g.title = 'Drag to resize · double-click to reset';
        ths[i].appendChild(g);
      }
      applyWidths(tbl, id, ths.length);
    }
  }
  var colDrag = null;
  content.addEventListener('mousedown', function (e) {
    var g = e.target.closest('.col-grip');
    if (!g || e.button !== 0) return;
    e.preventDefault();
    var tbl = g.closest('table');
    var id = tableIdOf(tbl);
    var n = tbl.querySelectorAll('thead th').length;
    var i = +g.getAttribute('data-col');
    // First drag freezes every column (except Title) at its current size,
    // then fixed layout takes over: shrinking a column below its content
    // width is exactly what auto layout forbids. Title itself only gets an
    // explicit width when ITS grip is dragged (colw entry stays null until
    // then) — otherwise it keeps absorbing the leftover width; widened
    // beyond the page, the table scrolls inside its section (overflow-x).
    var startW = g.parentElement.offsetWidth; // before the freeze reflows
    if (!colw[id] || colw[id].length !== n) {
      var ths = tbl.querySelectorAll('thead th'), w = [];
      for (var k = 0; k < n; k++) w.push(k === TITLE_COL ? null : ths[k].offsetWidth);
      colw[id] = w;
    }
    if (colw[id][i] != null) startW = colw[id][i];
    applyWidths(tbl, id, n);
    colDrag = { tbl: tbl, id: id, col: i, n: n, startX: e.clientX, startW: startW };
    g.classList.add('dragging');
    document.body.classList.add('col-resizing');
  });
  document.addEventListener('mousemove', function (e) {
    if (!colDrag) return;
    var w = Math.max(30, colDrag.startW + e.clientX - colDrag.startX);
    colw[colDrag.id][colDrag.col] = w;
    colsOf(colDrag.tbl, colDrag.n)[colDrag.col].style.width = w + 'px';
  });
  document.addEventListener('mouseup', function () {
    if (!colDrag) return;
    saveColw(); // a poll may have swapped the table mid-drag: colw is truth,
    var g = colDrag.tbl.querySelector('.col-grip.dragging'); // the next injection re-applies it
    if (g) g.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    colDrag = null;
    // The click that follows this mouseup fires on the COMMON ANCESTOR of the
    // press and release points (the th, or the table — never the grip, the
    // pointer moved away from it): swallow it in capture phase, otherwise
    // releasing a drag over a header sorts the column. The timeout clears the
    // flag if no click follows at all (release outside the window).
    swallowClick = true;
    setTimeout(function () { swallowClick = false; }, 0);
  });
  var swallowClick = false;
  document.addEventListener('click', function (e) {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
  }, true);
  // Double-click on a grip: back to auto layout for that table.
  content.addEventListener('dblclick', function (e) {
    var g = e.target.closest('.col-grip');
    if (!g) return;
    var tbl = g.closest('table');
    delete colw[tableIdOf(tbl)];
    saveColw();
    var cols = tbl.querySelectorAll('colgroup col');
    for (var i = 0; i < cols.length; i++) cols[i].style.width = '';
    tbl.classList.remove('resized');
  });
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
      if (!wasOpen && pop) showPop(cib, pop);
      return;
    }
    // Per-type diff popover: the +X −Y figures toggle the panel of their row
    // (same mechanics as the CI popover above).
    var dfb = e.target.closest('button.diff-btn');
    if (dfb) {
      var dpop = dfb.nextElementSibling;
      var dWasOpen = (dpop === openPop);
      closeCiPop();
      if (!dWasOpen && dpop) showPop(dfb, dpop);
      return;
    }
    // Column selector: the ⚙ of a table header toggles its checkbox menu.
    var colsBtn = e.target.closest('button.cols-btn');
    if (colsBtn) {
      var colsPop = colsBtn.nextElementSibling;
      var colsWasOpen = (colsPop === openPop);
      closeCiPop();
      if (!colsWasOpen && colsPop) {
        showPop(colsBtn, colsPop);
        openColsTable = colsBtn.getAttribute('data-cols-table');
      }
      return;
    }
    // Clicks inside the menu (labels, checkboxes) are handled by the change
    // listener — nothing else to do here.
    if (e.target.closest('.cols-pop')) return;
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
    // Stacked-PRs grouping: one global toggle (both tables), server-persisted.
    var stk = e.target.closest('button.stacks-toggle');
    if (stk) { act('/stacks'); return; }
    var btn = e.target.closest('.act');
    if (!btn) return;
    act('/hide', 'key=' + encodeURIComponent(btn.getAttribute('data-key')));
  });
  // Column-selector checkboxes (delegated on document: the OPEN popover is
  // reparented to <body> by showPop, so #content delegation would miss it).
  // POST /cols → the fragment comes back without/with the column; the open
  // menu is re-opened by setContent (openColsTable).
  document.addEventListener('change', function (e) {
    var el = e.target.closest('input[data-cols-key]');
    if (!el) return;
    var qs = 'key=' + encodeURIComponent(el.getAttribute('data-cols-key'));
    if (el.getAttribute('data-cols-table') === 'mine') qs += '&table=mine';
    act('/cols', qs);
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
