import { CATEGORY } from './filter.js';

// ── Sections (ordre d'affichage) ─────────────────────────────────────────
const SECTIONS = [
  { category: CATEGORY.REVIEW_REQUEST, icon: '🔍', label: 'Reviews demandées', withActor: false },
  { category: CATEGORY.MENTION,        icon: '💬', label: 'Mentions',          withActor: true },
  { category: CATEGORY.ON_MY_PR,       icon: '📥', label: 'Activité sur tes PR', withActor: true },
  { category: CATEGORY.THREAD_REPLY,   icon: '↩️', label: 'Réponses à tes commentaires', withActor: true },
];

const TITLE_MAX = 60;
const REPO_MAX = 32;

// ── Couleur & liens (désactivés hors TTY ou si NO_COLOR) ─────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m',
};

function resolveOpts(opts) {
  const tty = !!process.stdout.isTTY;
  return {
    color: opts?.color ?? (tty && !process.env.NO_COLOR),
    hyperlinks: opts?.hyperlinks ?? tty,
  };
}

function paint(text, code, opts) {
  return opts.color && code ? `${code}${text}${C.reset}` : text;
}

// Hyperlien terminal OSC 8 : le texte devient cliquable, l'URL n'est pas affichée.
export function hyperlink(url, text, opts) {
  if (!opts.hyperlinks || !url) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// ── Largeur d'affichage (compte 2 colonnes pour les emojis larges) ───────
function isWide(cp) {
  // Emojis larges uniquement. On exclut volontairement le bloc box-drawing
  // (U+2500–U+257F) et les flèches, qui s'affichent sur une seule colonne.
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
    (cp >= 0x2600 && cp <= 0x27bf) ||  // symboles divers + dingbats
    (cp >= 0x1f000 && cp <= 0x1faff)   // plans emoji
  );
}

export function displayWidth(text) {
  let w = 0;
  for (const ch of text) w += isWide(ch.codePointAt(0)) ? 2 : 1;
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

// ── Construction d'un tableau encadré ────────────────────────────────────
// columns: [{ header, max?, color? }]
// rows: [[{ text, url?, color? }, ...], ...]  (une cellule par colonne)
function buildTable(columns, rows, opts) {
  const widths = columns.map((col, i) => {
    const natural = Math.max(displayWidth(col.header), ...rows.map((r) => displayWidth(r[i].text)), 0);
    return col.max ? Math.min(natural, col.max) : natural;
  });

  const border = (l, m, r) => paint(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r, C.dim, opts);

  const renderRow = (cells, isHeader) =>
    paint('│', C.dim, opts) +
    cells
      .map((cell, i) => {
        const plain = truncate(cell.text, widths[i]);
        const pad = ' '.repeat(widths[i] - displayWidth(plain));
        let shown = isHeader ? paint(plain, C.bold, opts) : paint(plain, cell.color, opts);
        if (!isHeader) shown = hyperlink(cell.url, shown, opts);
        return ` ${shown}${pad} `;
      })
      .join(paint('│', C.dim, opts)) +
    paint('│', C.dim, opts);

  return [
    border('┌', '┬', '┐'),
    renderRow(columns.map((c) => ({ text: c.header })), true),
    border('├', '┼', '┤'),
    ...rows.map((r) => renderRow(r, false)),
    border('└', '┴', '┘'),
  ].join('\n');
}

function itemRow(item, withActor) {
  const titleText = withActor && item.actor ? `${item.title} — @${item.actor}` : item.title;
  return [
    { text: item.repo, color: C.cyan, url: item.url },
    { text: `#${item.number}`, color: C.yellow, url: item.url },
    { text: titleText, url: item.url },
  ];
}

function sectionBlock(section, group, opts) {
  const columns = [
    { header: 'Dépôt', max: REPO_MAX },
    { header: 'PR' },
    { header: section.withActor ? 'Titre / Qui' : 'Titre', max: TITLE_MAX },
  ];
  const rows = group.map((item) => itemRow(item, section.withActor));
  const heading = `${section.icon} ${paint(section.label, C.bold, opts)} ${paint(`(${group.length})`, C.dim, opts)}`;
  return `${heading}\n${buildTable(columns, rows, opts)}`;
}

function pendingBlock(pending, opts) {
  const columns = [
    { header: 'Dépôt', max: REPO_MAX },
    { header: 'PR' },
    { header: 'Titre', max: TITLE_MAX },
  ];
  const rows = pending.map((p) => [
    { text: p.repo, color: C.cyan, url: p.url },
    { text: `#${p.number}`, color: C.yellow, url: p.url },
    { text: p.title, url: p.url },
  ]);
  const heading = `📋 ${paint('Reviews en attente', C.bold, opts)} ${paint(`(${pending.length})`, C.dim, opts)}`;
  return `${heading}\n${buildTable(columns, rows, opts)}`;
}

export function renderList(items, pending, opts) {
  const o = resolveOpts(opts);
  const blocks = [];
  for (const section of SECTIONS) {
    const group = items.filter((i) => i.category === section.category);
    if (group.length === 0) continue;
    blocks.push(sectionBlock(section, group, o));
  }
  if (pending.length > 0) blocks.push(pendingBlock(pending, o));
  if (blocks.length === 0) return 'Rien à signaler ✨\n';
  return blocks.join('\n\n') + '\n';
}
