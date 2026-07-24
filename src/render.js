// Couleur & liens (désactivés hors TTY ou si NO_COLOR), construction de tableaux
// encadrés alignés, et helpers d'affichage (triggers, CI, date relative, diff).
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

// ── Largeur d'affichage ──────────────────────────────────────────────────
// Compte 2 colonnes pour les emojis larges, 0 pour les sélecteurs de variante
// (U+FE0F). Une base immédiatement suivie de U+FE0F (présentation emoji, ex.
// ↩️) compte donc 2. Le box-drawing et le signe « − » restent à 1.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
    (cp >= 0x2600 && cp <= 0x27bf) ||  // symboles divers + dingbats (✅ ❌ …)
    (cp >= 0x1f000 && cp <= 0x1faff)   // plans emoji (🔍 💬 🟩 🟥 🟡 …)
  );
}

export function displayWidth(text) {
  const chars = [...text];
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue;                 // sélecteur de variante : 0
    const next = chars[i + 1] ? chars[i + 1].codePointAt(0) : 0;
    if (next === 0xfe0f) { w += 2; continue; }                 // base + VS16 → emoji large
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

// ── Helpers de présentation ──────────────────────────────────────────────
const TRIGGER_ORDER = ['review', 'mention', 'reply', 'comment'];
const TRIGGER_ICON = {
  review: '🔍',
  mention: '💬',
  reply: '↩️',
  comment: '🗨️', // U+1F5E8 + U+FE0F : sans le sélecteur, présentation texte (largeur 1) → décalage
};

// Emojis seuls (espace pour gagner de la place). Légende : 🔍 review · 💬 mention
// · ↩️ réponse · 🗨 commentaire (cf. README).
export function triggersLabel(keys) {
  return TRIGGER_ORDER.filter((k) => keys.includes(k)).map((k) => TRIGGER_ICON[k]).join(' ');
}

const CI_ICON = { pass: '✅', fail: '❌', pending: '🟡', none: '·' };
export function ciIcon(state) {
  return CI_ICON[state] || '·';
}

// État de la PR : 📝 draft · 🟢 ouverte · 🟣 mergée · 🔴 fermée.
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
  if (d > 0) return `il y a ${d}j`;
  if (h > 0) return `il y a ${h}h`;
  if (min > 0) return `il y a ${min}min`;
  return "à l'instant";
}

// Renvoie { text, render(opts) } : `text` (brut) sert au calcul de largeur ;
// `render` colore +ajouts en vert / −retraits en rouge (même largeur visible).
export function diffStat(additions, deletions) {
  const a = additions || 0;
  const d = deletions || 0;
  const text = `+${a} −${d}`;
  const render = (opts) => `${paint('+' + a, C.green, opts)} ${paint('−' + d, C.red, opts)}`;
  return { text, render };
}

// ── Construction d'un tableau encadré ────────────────────────────────────
// columns: [{ header, max? }]
// rows: [[cell, ...]] où cell = { text, url?, color?, render?(opts) }
//   - `text` est toujours le texte brut servant à la largeur/troncature
//   - `render` (optionnel, colonnes non plafonnées) fournit un rendu décoré de
//     même largeur visible que `text`
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
    { header: 'Dépôt', max: REPO_MAX },
    { header: 'PR' },
    { header: 'Titre', max: TITLE_MAX },
    { header: 'État' },
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

// Cellule « approbations » de mes PR : compteur, suffixé de 🎉 quand la PR est
// OUVERTE et atteint le seuil (« prête à merger »). `·` si aucune approbation.
function approvalsText(r) {
  if (!r.approvals) return '·';
  const ready = r.state === 'open' && isReady(r.approvals);
  return ready ? `${r.approvals} 🎉` : String(r.approvals);
}

function othersTable(rows, opts) {
  // Colonne de marqueur 🙈 en tête, uniquement s'il y a au moins une PR masquée
  // à afficher (sinon, pas de colonne vide). La sélection se fait au numéro de PR.
  const withMarker = opts.hiddenFlags.some(Boolean);
  const columns = [
    ...(withMarker ? [{ header: '' }] : []),
    { header: 'Dépôt', max: REPO_MAX },
    { header: 'PR' },
    { header: 'Titre', max: TITLE_MAX },
    { header: 'Auteur' },
    { header: 'Ouverte' },
    { header: 'Diff' },
    { header: 'État' },
    { header: '✅' },
    { header: 'Triggers' },
    { header: 'CI' },
  ];
  const cells = rows.map((r, i) => {
    const diff = diffStat(r.additions, r.deletions);
    const isHid = !!opts.hiddenFlags[i];
    const marker = isHid ? '🙈' : '';
    const col = (color) => (isHid ? C.dim : color); // lignes masquées : grisées
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
    const heading = `📥 ${paint('Tes PR ouvertes', C.bold, o)} ${paint(`(${data.mine.length})`, C.dim, o)}`;
    blocks.push(`${heading}\n${mineTable(data.mine, o)}`);
  }
  if (data.others && data.others.length > 0) {
    const hiddenInView = o.hiddenFlags.filter(Boolean).length;
    const visible = data.others.length - hiddenInView;
    const hiddenCount = data.hiddenCount ?? hiddenInView;
    const count = hiddenCount > 0
      ? `(${visible}, ${hiddenCount} masquée${hiddenCount > 1 ? 's' : ''})`
      : `(${data.others.length})`;
    const heading = `👥 ${paint('Activité sur les PR des autres', C.bold, o)} ${paint(count, C.dim, o)}`;
    blocks.push(`${heading}\n${othersTable(data.others, o)}`);
  }
  if (blocks.length === 0) return 'Rien à signaler ✨\n';
  return blocks.join('\n\n') + '\n';
}

// Barre de favoris du mode terminal : « ⭐ tous · [mapado] · zenstruck », l'actif
// entre crochets et en gras. Liste vide → chaîne vide (rien ne s'affiche pour qui
// n'utilise pas les favoris). Rendue HORS des tableaux encadrés : aucune
// contrainte d'alignement, donc pas d'impact sur displayWidth (cf. §5).
export function favoritesBar(favorites, active, opts) {
  const o = resolveOpts(opts);
  if (!favorites || favorites.length === 0) return '';
  const cell = (label, on) => (on ? paint(`[${label}]`, C.bold, o) : paint(label, C.dim, o));
  const parts = [cell('⭐ tous', !active), ...favorites.map((f) => cell(favoriteLabel(f), f === active))];
  return parts.join(paint(' · ', C.dim, o));
}

// Dump terminal du verdict de classification par thread (mode --debug). Une ligne
// par thread : marque (gardé → catégorie / droppé → ✗), repo#number, raison, et
// méta (reason GitHub brute + nb de commentaires). Liste libre (pas de tableau).
export function renderDebugText(debug, opts) {
  const o = resolveOpts(opts);
  if (!debug || debug.length === 0) {
    return `🐛 ${paint('Debug — aucun thread de notification', C.dim, o)}\n${checksSectionText(opts)}`;
  }
  const lines = debug.map((d) => {
    const v = d.verdict;
    const mark = v.kept ? paint(`✓ ${v.category}`, C.green, o) : paint('✗ droppé', C.dim, o);
    const meta = paint(`(GH:${d.ghReason}, ${d.commentsCount} comm.)`, C.dim, o);
    return `  ${mark}  ${d.repo}#${d.number}  ${paint('·', C.dim, o)} ${v.reason}  ${meta}`;
  });
  const kept = debug.filter((d) => d.verdict.kept).length;
  const title = `🐛 ${paint('Debug — verdict du pipeline', C.bold, o)} ${paint(`(${kept}/${debug.length} gardés)`, C.dim, o)}`;
  return `${title}\n${lines.join('\n')}\n${checksSectionText(opts)}`;
}

// Regroupe des rows par repo → checks DISTINCTS (union, ordre de 1re apparition).
// La blocklist étant par repo, la config des checks ignorés se raisonne par repo,
// pas par PR (un même job apparaît sur plusieurs PR). Un repo sans check est absent.
// Partagé par les deux vues debug (terminal `checksSectionText` + web `renderChecksSection`).
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

// Section « Checks par repo » du dump terminal (mode --debug) : par repo, l'ensemble
// DISTINCT de ses jobs (union sur ses PR), les ignorés (blocklist du repo) suffixés
// « (ignoré) » et grisés. Aide à copier le nom exact d'un job à mettre en blocklist.
// '' si aucune row (compat). Le state d'un job étant par PR, il n'est pas affiché ici
// (config = par repo) — le verdict par PR reste dans les tableaux principaux.
function checksSectionText(opts) {
  const o = resolveOpts(opts);
  const groups = checksByRepo(opts?.rows);
  if (groups.length === 0) return '';
  const ignoredChecks = opts?.ignoredChecks ?? {};
  const blocks = groups.map(({ repo, names }) => {
    const blocked = new Set((ignoredChecks[repo] ?? []).map((n) => String(n).trim()));
    const items = names.map((name) => {
      const ign = blocked.has(name);
      const line = `    ${name}${ign ? ' (ignoré)' : ''}`;
      return ign ? paint(line, C.dim, o) : line;
    });
    return [`  ${paint(repo, C.bold, o)}`, ...items].join('\n');
  });
  const title = `🔎 ${paint('Checks par repo', C.bold, o)}`;
  return `${title}\n${blocks.join('\n')}\n`;
}
