// Rendu HTML pur (aucune I/O) pour le mode `gh notif --serve`. Réutilise les
// helpers de présentation déjà exportés par render.js (triggersLabel, ciIcon,
// stateIcon, relativeDate) : seule la mise en forme (terminal vs HTML) diffère,
// la logique d'affichage reste mutualisée.
import { ciIcon, stateIcon, relativeDate } from './render.js';

// Libellés affichés au survol (title="") des icônes — donnent le sens.
const STATE_LABEL = { draft: 'Brouillon', open: 'Ouverte', merged: 'Mergée', closed: 'Fermée' };
const CI_LABEL = { pass: 'CI : succès', fail: 'CI : échec', pending: 'CI : en cours', none: 'CI : aucune' };
// Ordre + sens des triggers (mêmes emojis que render.js).
const TRIGGER_META = [
  ['review', '🔍', 'Review demandée'],
  ['mention', '💬', 'Mention'],
  ['reply', '↩️', 'Réponse à ton fil'],
  ['comment', '🗨️', 'Commentaire sur ta PR'],
];
// En-tête de la colonne « approbations » (icône cryptique → title au survol).
const APPROVALS_TH = '<abbr title="Approbations" style="text-decoration:none;cursor:help">✅</abbr>';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Échappe toute donnée issue de GitHub (titre, repo, auteur, url) avant de
// l'injecter dans la page. Indispensable : un titre de PR peut contenir
// `<`, `&`, `"`… (correctness + anti-injection).
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// Liens en nouvel onglet (target=_blank), avec rel=noopener (sécurité).
const link = (url, text) =>
  `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;

const diffCell = (additions, deletions) =>
  `<span class="add">+${additions || 0}</span> <span class="del">−${deletions || 0}</span>`;

// Cellules « icône » avec title="" explicatif au survol.
const titled = (title, content) => `<span title="${escapeHtml(title)}">${content}</span>`;
const stateCell = (state) => titled(STATE_LABEL[state] || state || '', stateIcon(state));
const ciCell = (ci) => titled(CI_LABEL[ci] || 'CI : aucune', ciIcon(ci));
const triggersCell = (keys) => {
  const set = new Set(keys || []);
  return TRIGGER_META.filter(([k]) => set.has(k))
    .map(([, icon, label]) => titled(label, icon))
    .join(' ');
};
const approvalsCell = (n) =>
  n ? titled(`${n} approbation${n > 1 ? 's' : ''}`, String(n)) : titled('Aucune approbation', '·');

const tableRow = (cells, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

function table(headers, rows) {
  const head = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows.join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function mineTable(rows) {
  const headers = ['Dépôt', 'PR', 'Titre', 'État', APPROVALS_TH, 'Triggers', 'CI'];
  const trs = rows.map((r) =>
    tableRow([
      link(r.url, r.repo),
      link(r.url, `#${r.number}`),
      link(r.url, r.title),
      stateCell(r.state),
      approvalsCell(r.approvals),
      triggersCell(r.triggers),
      ciCell(r.ci),
    ]),
  );
  return table(headers, trs);
}

// Bouton de masquage (✕) ou de restauration (↩︎) pour une ligne « autres ».
function actionButton(r, hidden) {
  const key = escapeHtml(`${r.repo}#${r.number}`);
  return hidden
    ? `<button class="act" data-key="${key}" data-act="show" title="Restaurer">↩︎</button>`
    : `<button class="act" data-key="${key}" data-act="hide" title="Masquer">✕</button>`;
}

function otherRow(r, now, hidden) {
  return tableRow(
    [
      link(r.url, r.repo),
      link(r.url, `#${r.number}`),
      link(r.url, r.title),
      r.author ? `@${escapeHtml(r.author)}` : '?',
      titled('Ouverte ' + relativeDate(r.createdAt, now), escapeHtml(relativeDate(r.createdAt, now))),
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

function othersTable(others, hiddenRows, now, showHidden) {
  const headers = ['Dépôt', 'PR', 'Titre', 'Auteur', 'Ouverte', 'Diff', 'État', APPROVALS_TH, 'Triggers', 'CI', ''];
  const trs = [
    ...others.map((r) => otherRow(r, now, false)),
    ...(showHidden ? hiddenRows.map((r) => otherRow(r, now, true)) : []),
  ];
  return table(headers, trs);
}

// HTML des deux tableaux (le « fragment » re-fetché en boucle par la page).
// `now` est injectable pour des tests déterministes (comme render.js).
// `showHidden` ajoute les lignes masquées (grisées, bouton restaurer).
export function renderFragment(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const showHidden = !!opts.showHidden;
  const mine = data?.mine ?? [];
  const others = data?.others ?? [];
  const hiddenRows = data?.hidden ?? [];
  const hiddenCount = data?.hiddenCount ?? hiddenRows.length;

  const blocks = [];
  if (mine.length > 0) {
    blocks.push(`<section><h2>📥 Tes PR ouvertes (${mine.length})</h2>${mineTable(mine)}</section>`);
  }
  if (others.length > 0 || (showHidden && hiddenCount > 0)) {
    const count =
      hiddenCount > 0
        ? `(${others.length}, ${hiddenCount} masquée${hiddenCount > 1 ? 's' : ''})`
        : `(${others.length})`;
    blocks.push(
      `<section><h2>👥 Activité sur les PR des autres ${count}</h2>${othersTable(others, hiddenRows, now, showHidden)}</section>`,
    );
  }
  if (blocks.length === 0) return '<p class="empty">Rien à signaler ✨</p>';
  return blocks.join('\n');
}

// Bloc affiché tant que le serveur n'a pas encore récupéré de données (1er poll
// à froid). Le `data-loading` sert au client à re-poller vite jusqu'aux données.
export function renderLoading() {
  return '<p class="empty" data-loading="1"><span class="spinner"></span> Chargement des notifications…</p>';
}

// Page complète servie sur `/` : coquille HTML + CSS + JS inline (aucun asset
// externe). Le JS recharge `/fragment` au démarrage puis toutes les `intervalMs`
// (avec compte à rebours), gère le bouton « rafraîchir », le mode « voir les
// masquées », le masquage par bouton, et le filtre org/repo. `scopeLabel` préremplit
// le champ de scope. Le rythme client est découplé du poll GitHub côté serveur.
export function renderShell({ intervalMs = 10000, scopeLabel = '' } = {}) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gh notif</title>
<style>
  /* Palette GitHub Primer (light par défaut, dark via prefers-color-scheme). */
  :root {
    color-scheme: light dark;
    --canvas: #ffffff; --canvas-subtle: #f6f8fa; --canvas-inset: #f6f8fa;
    --fg: #1f2328; --fg-muted: #59636e; --border: #d1d9e0; --border-muted: #d1d9e0b3;
    --accent: #0969da; --success: #1a7f37; --danger: #cf222e;
    --btn-bg: #f6f8fa; --btn-border: #1f23280f; --btn-hover: #eef1f4; --shadow: 0 1px 0 #1f23280a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #0d1117; --canvas-subtle: #151b23; --canvas-inset: #010409;
      --fg: #e6edf3; --fg-muted: #9198a1; --border: #3d444d; --border-muted: #3d444db3;
      --accent: #4493f8; --success: #3fb950; --danger: #f85149;
      --btn-bg: #212830; --btn-border: #f0f6fc1a; --btn-hover: #2a313c; --shadow: 0 0 transparent;
    }
  }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
         margin: 0; padding: 1rem 1.5rem; background: var(--canvas); color: var(--fg); }
  header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin-bottom: 1.25rem;
           padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 1rem; font-weight: 600; margin: 0; }
  #stamp { font-size: .8rem; color: var(--fg-muted); }
  .spacer { flex: 1; }
  .controls { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  button, input { font: inherit; }
  button { cursor: pointer; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--fg);
           border-radius: 6px; padding: .3rem .75rem; font-size: .8125rem; font-weight: 500; box-shadow: var(--shadow); }
  button:hover { background: var(--btn-hover); }
  button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  #scope { width: 13rem; padding: .3rem .65rem; border-radius: 6px; font-size: .8125rem;
           border: 1px solid var(--border); background: var(--canvas); color: var(--fg); }
  #scope:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
  /* Section = « Box » GitHub : bordure arrondie, en-tête sur fond subtle. */
  section { margin: 0 0 1.5rem; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  h2 { font-size: .875rem; font-weight: 600; margin: 0; padding: .65rem 1rem;
       background: var(--canvas-subtle); border-bottom: 1px solid var(--border); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem 1rem; border-bottom: 1px solid var(--border-muted); white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  th { font-weight: 600; color: var(--fg-muted); font-size: .75rem; }
  /* Colonne Titre : absorbe la largeur restante et tronque sur une seule ligne
     (astuce width:100% + max-width:0 + ellipsis sur un tableau auto-layout). */
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
  <h1>🔔 gh notif</h1>
  <span id="stamp">chargement…</span>
  <span class="spacer"></span>
  <span class="controls">
    <input id="scope" placeholder="org ou owner/repo" value="${escapeHtml(scopeLabel)}">
    <button id="scope-apply" title="Filtrer sur ce scope">Filtrer</button>
    <button id="scope-all" title="Tout afficher">Tout</button>
    <button id="toggle-hidden" title="Afficher/masquer les PR cachées">🙈 masquées</button>
    <button id="refresh" title="Rafraîchir maintenant">🔄</button>
  </span>
</header>
<main id="content"></main>
<script>
  var INTERVAL = ${Number(intervalMs)};
  var content = document.getElementById('content');
  var stamp = document.getElementById('stamp');
  var scopeInput = document.getElementById('scope');
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
    stamp.innerHTML = '<span class="spinner"></span> mise à jour…';
  }
  function setContent(html) {
    content.innerHTML = html;
    left = INTERVAL / 1000;
    stamp.classList.remove('offline');
    stamp.textContent = 'maj ' + new Date().toLocaleTimeString('fr-FR');
    // Serveur pas encore prêt (1er poll en cours) → on re-poll vite.
    if (content.querySelector('[data-loading]')) left = 1;
  }
  function fail() {
    stamp.classList.add('offline');
    stamp.textContent = 'hors ligne — nouvelle tentative…';
  }
  function load() {
    busy();
    fetch('/fragment' + q()).then(function (r) { return r.text(); }).then(setContent).catch(fail);
  }
  function post(path, extra) {
    busy();
    return fetch(path + q(extra), { method: 'POST' }).then(function (r) { return r.text(); }).then(setContent).catch(fail);
  }

  document.getElementById('refresh').addEventListener('click', function () { post('/refresh'); });
  toggleBtn.addEventListener('click', function () {
    showHidden = !showHidden;
    toggleBtn.classList.toggle('on', showHidden);
    load();
  });
  document.getElementById('scope-apply').addEventListener('click', function () {
    post('/scope', 'value=' + encodeURIComponent(scopeInput.value.trim()));
  });
  document.getElementById('scope-all').addEventListener('click', function () {
    scopeInput.value = '';
    post('/scope', 'value=');
  });
  content.addEventListener('click', function (e) {
    var btn = e.target.closest('.act');
    if (!btn) return;
    post('/hide', 'key=' + encodeURIComponent(btn.getAttribute('data-key')));
  });

  setInterval(function () {
    left -= 1;
    if (left <= 0) { load(); return; }
    var base = stamp.textContent.split('  ·  ')[0];
    if (!stamp.classList.contains('offline')) stamp.textContent = base + '  ·  prochaine vérif dans ' + left + 's';
  }, 1000);

  load();
</script>
</body>
</html>`;
}
