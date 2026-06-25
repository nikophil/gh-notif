// Couleur & liens (désactivés hors TTY ou si NO_COLOR), construction de tableaux
// encadrés alignés, et helpers d'affichage (triggers, CI, date relative, diff).

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
    hideMode: !!opts?.hideMode,
    showHidden: !!opts?.showHidden,
    labels: opts?.labels ?? [],
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
    { text: r.approvals ? String(r.approvals) : '·', color: C.green },
    { text: triggersLabel(r.triggers) },
    { text: ciIcon(r.ci) },
  ]);
  return buildTable(columns, cells, opts);
}

function othersTable(rows, opts) {
  // Colonne de marqueur en tête : numéro (mode masquage) ou 🙈 (vue masquées).
  const withMarker = opts.hideMode || opts.showHidden;
  const columns = [
    ...(withMarker ? [{ header: '#' }] : []),
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
    // marqueur : numéro en mode masquage, sinon 🙈 si masquée, sinon vide
    const marker = opts.hideMode ? (opts.labels[i] || '') : (isHid ? '🙈' : '');
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
