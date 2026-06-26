// Rendu HTML pur (aucune I/O) pour le mode `gh notif --serve`. Réutilise les
// helpers de présentation déjà exportés par render.js (triggersLabel, ciIcon,
// stateIcon, relativeDate) : seule la mise en forme (terminal vs HTML) diffère,
// la logique d'affichage reste mutualisée.
import { triggersLabel, ciIcon, stateIcon, relativeDate } from './render.js';

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

const approvals = (n) => (n ? String(n) : '·');

const tableRow = (cells, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

function table(headers, rows) {
  const head = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows.join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function mineTable(rows) {
  const headers = ['Dépôt', 'PR', 'Titre', 'État', '✅', 'Triggers', 'CI'];
  const trs = rows.map((r) =>
    tableRow([
      link(r.url, r.repo),
      link(r.url, `#${r.number}`),
      link(r.url, r.title),
      stateIcon(r.state),
      approvals(r.approvals),
      escapeHtml(triggersLabel(r.triggers || [])),
      ciIcon(r.ci),
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
      escapeHtml(relativeDate(r.createdAt, now)),
      diffCell(r.additions, r.deletions),
      stateIcon(r.state),
      approvals(r.approvals),
      escapeHtml(triggersLabel(r.triggers || [])),
      ciIcon(r.ci),
      actionButton(r, hidden),
    ],
    hidden ? 'hid' : '',
  );
}

function othersTable(others, hiddenRows, now, showHidden) {
  const headers = ['Dépôt', 'PR', 'Titre', 'Auteur', 'Ouverte', 'Diff', 'État', '✅', 'Triggers', 'CI', ''];
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
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 1.5rem;
         background: Canvas; color: CanvasText; }
  header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  header h1 { font-size: 1.1rem; margin: 0; }
  #stamp { font-size: .85rem; opacity: .6; }
  .spacer { flex: 1; }
  .controls { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  button, input { font: inherit; }
  button { cursor: pointer; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
           background: color-mix(in srgb, CanvasText 6%, transparent); color: inherit;
           border-radius: 6px; padding: .25rem .6rem; }
  button:hover { background: color-mix(in srgb, CanvasText 14%, transparent); }
  button.on { background: color-mix(in srgb, CanvasText 22%, transparent); }
  #scope { width: 12rem; padding: .25rem .5rem; border-radius: 6px;
           border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Canvas; color: inherit; }
  section { margin: 0 0 1.75rem; }
  h2 { font-size: 1rem; margin: 0 0 .5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
           white-space: nowrap; }
  th { font-weight: 600; opacity: .7; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  td:nth-child(3) { white-space: normal; max-width: 32rem; }
  tr:hover td { background: color-mix(in srgb, CanvasText 5%, transparent); }
  tr.hid td { opacity: .45; }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .act { padding: .1rem .45rem; line-height: 1; }
  .add { color: #3fb950; } .del { color: #f85149; }
  .empty { opacity: .6; font-size: 1.1rem; }
  .offline { color: #f85149 !important; }
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
  function setContent(html) {
    content.innerHTML = html;
    left = INTERVAL / 1000;
    stamp.classList.remove('offline');
    stamp.textContent = 'maj ' + new Date().toLocaleTimeString('fr-FR');
  }
  function fail() {
    stamp.classList.add('offline');
    stamp.textContent = 'hors ligne — nouvelle tentative…';
  }
  function load() {
    fetch('/fragment' + q()).then(function (r) { return r.text(); }).then(setContent).catch(fail);
  }
  function post(path, extra) {
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
