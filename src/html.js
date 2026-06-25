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

const link = (url, text) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;

const diffCell = (additions, deletions) =>
  `<span class="add">+${additions || 0}</span> <span class="del">−${deletions || 0}</span>`;

const approvals = (n) => (n ? String(n) : '·');

const tableRow = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

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

function othersTable(rows, now) {
  const headers = ['Dépôt', 'PR', 'Titre', 'Auteur', 'Ouverte', 'Diff', 'État', '✅', 'Triggers', 'CI'];
  const trs = rows.map((r) =>
    tableRow([
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
    ]),
  );
  return table(headers, trs);
}

// HTML des deux tableaux (le « fragment » re-fetché en boucle par la page).
// `now` est injectable pour des tests déterministes (comme render.js).
export function renderFragment(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const mine = data?.mine ?? [];
  const others = data?.others ?? [];
  const blocks = [];
  if (mine.length > 0) {
    blocks.push(`<section><h2>📥 Tes PR ouvertes (${mine.length})</h2>${mineTable(mine)}</section>`);
  }
  if (others.length > 0) {
    blocks.push(
      `<section><h2>👥 Activité sur les PR des autres (${others.length})</h2>${othersTable(others, now)}</section>`,
    );
  }
  if (blocks.length === 0) return '<p class="empty">Rien à signaler ✨</p>';
  return blocks.join('\n');
}

// Page complète servie sur `/` : coquille HTML + CSS + JS inline (aucun asset
// externe). Le JS recharge `/fragment` au démarrage puis toutes les `intervalMs`
// et remplace #content — le rythme de polling client est découplé du poll GitHub
// côté serveur (cf. serve.js). `intervalMs` est injecté tel quel dans le script.
export function renderShell({ intervalMs = 10000 } = {}) {
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
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1rem; }
  header h1 { font-size: 1.1rem; margin: 0; }
  #stamp { font-size: .85rem; opacity: .6; }
  section { margin: 0 0 1.75rem; }
  h2 { font-size: 1rem; margin: 0 0 .5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
           white-space: nowrap; }
  th { font-weight: 600; opacity: .7; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  td:nth-child(3) { white-space: normal; max-width: 32rem; }
  tr:hover td { background: color-mix(in srgb, CanvasText 5%, transparent); }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .add { color: #3fb950; } .del { color: #f85149; }
  .empty { opacity: .6; font-size: 1.1rem; }
  .offline { color: #f85149 !important; }
</style>
</head>
<body>
<header>
  <h1>🔔 gh notif</h1>
  <span id="stamp">chargement…</span>
</header>
<main id="content"></main>
<script>
  var INTERVAL = ${Number(intervalMs)};
  var content = document.getElementById('content');
  var stamp = document.getElementById('stamp');
  function refresh() {
    fetch('/fragment').then(function (r) { return r.text(); }).then(function (html) {
      content.innerHTML = html;
      stamp.classList.remove('offline');
      stamp.textContent = 'maj ' + new Date().toLocaleTimeString('fr-FR');
    }).catch(function () {
      stamp.classList.add('offline');
      stamp.textContent = 'hors ligne — nouvelle tentative…';
    });
  }
  refresh();
  setInterval(refresh, INTERVAL);
</script>
</body>
</html>`;
}
