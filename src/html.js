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
