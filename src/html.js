// Rendu HTML pur (aucune I/O) pour le mode `gh notif --serve`. Réutilise les
// helpers de présentation déjà exportés par render.js (triggersLabel, ciIcon,
// stateIcon, relativeDate) : seule la mise en forme (terminal vs HTML) diffère,
// la logique d'affichage reste mutualisée.
import { ciIcon, stateIcon, relativeDate } from './render.js';
import { isReady } from './approvals.js';

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

// Favicon : le logo (mark) GitHub embarqué en data-URI SVG (zéro asset externe,
// comme le reste des pages). Theme-aware via une media query interne au SVG —
// mark sombre sur onglet clair, clair sur onglet sombre. ⚠️ Le `#` des couleurs
// doit être encodé `%23` dans un data-URI (sinon interprété comme fragment).
const FAVICON =
  '<link rel="icon" href="data:image/svg+xml,' +
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
  "<style>path{fill:%231f2328}@media(prefers-color-scheme:dark){path{fill:%23e6edf3}}</style>" +
  "<path d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z'/>" +
  '</svg>">';

// Variables de couleur GitHub Primer, source unique réutilisée pour les 4 cas de
// thème (auto/système, auto/dark, light forcé, dark forcé) sans les tripler.
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
// `ready` (PR à moi ouverte & ≥ seuil) ajoute le badge 🎉 « prête à merger ».
const approvalsCell = (n, ready = false) => {
  if (!n) return titled('Aucune approbation', '·');
  const count = titled(`${n} approbation${n > 1 ? 's' : ''}`, String(n));
  return ready ? `${count} ${titled('Prête à merger', '🎉')}` : count;
};

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
      approvalsCell(r.approvals, r.state === 'open' && isReady(r.approvals)),
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
export function renderShell({ intervalMs = 10000, scopeLabel = '', notifyEnabled = true, theme = 'auto' } = {}) {
  return `<!doctype html>
<html lang="fr" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gh notif</title>
${FAVICON}
<style>
  /* Palette GitHub Primer. Clair par défaut ; le thème est piloté par
     data-theme sur <html> : "auto" suit le système (media query), "light"/"dark"
     forcent. [data-theme] (spécificité 0,1,1) l'emporte sur :root dans la media
     query → l'override explicite gagne toujours. */
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
  /* Case « notifs desktop » : label + checkbox alignés dans la barre de contrôles. */
  #notify-label { display: flex; align-items: center; gap: .35rem; font-size: .8125rem;
                  color: var(--fg-muted); cursor: pointer; user-select: none; }
  #notify { cursor: pointer; margin: 0; accent-color: var(--accent); }
  /* Switcher de thème : boutons accolés en « segmented control », l'actif = .on. */
  .theme-switch { display: inline-flex; }
  .theme-switch button { border-radius: 0; margin-left: -1px; }
  .theme-switch button:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
  .theme-switch button:last-child { border-radius: 0 6px 6px 0; }
  .theme-switch button.on { position: relative; z-index: 1; }
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
    <label id="notify-label" title="Activer/désactiver les notifications desktop">
      <input type="checkbox" id="notify"${notifyEnabled ? ' checked' : ''}> 🔔 notifs
    </label>
    <span class="theme-switch" role="group" aria-label="Thème">
      <button type="button" data-theme-val="auto"${theme === 'auto' ? ' class="on"' : ''} title="Thème : auto (système)">🌗 auto</button>
      <button type="button" data-theme-val="light"${theme === 'light' ? ' class="on"' : ''} title="Thème : clair">☀️ clair</button>
      <button type="button" data-theme-val="dark"${theme === 'dark' ? ' class="on"' : ''} title="Thème : sombre">🌙 sombre</button>
    </span>
    <button id="refresh" title="Rafraîchir maintenant">🔄</button>
    <a id="debug-link" href="/debug" title="Debug : verdict du pipeline">🐛</a>
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
  document.getElementById('notify').addEventListener('change', function (e) {
    // Pilote le flag serveur ; la case vit dans le <header> (hors #content) donc
    // elle survit aux refresh du fragment. On ne remplace pas #content ici.
    fetch('/notify?enabled=' + (e.target.checked ? '1' : '0'), { method: 'POST' });
  });
  var themeSwitch = document.querySelector('.theme-switch');
  themeSwitch.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-theme-val]');
    if (!btn) return;
    var val = btn.getAttribute('data-theme-val');
    // Applique tout de suite (pas de reload), met à jour le bouton actif, persiste.
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

// Fragment HTML du debug : un tableau « verdict du pipeline » par thread de
// notification. Toute donnée GitHub (titre, repo, raison, reason brute) est
// échappée (anti-injection). `now` accepté pour symétrie/déterminisme.
export function renderDebug(debug, opts = {}) {
  const rows = debug ?? [];
  if (rows.length === 0) return '<p class="empty">Aucun thread de notification.</p>';
  const kept = rows.filter((d) => d.verdict.kept).length;
  const headers = ['Verdict', 'PR', 'Titre', 'Raison', 'reason GitHub', 'Comm.'];
  const trs = rows.map((d) => {
    const v = d.verdict;
    const url = `https://github.com/${d.repo}/pull/${d.number}`;
    const verdict = v.kept
      ? `<span class="ok">✓ ${escapeHtml(v.category)}</span>`
      : '<span class="ko">✗ droppé</span>';
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
  return `<p class="summary">${kept}/${rows.length} threads gardés</p>${table(headers, trs)}`;
}

// Page autonome `/debug` (CSS inline minimal, zéro asset externe) : poll de
// `/debug-fragment` toutes les `intervalMs`, lien retour vers `/`.
export function renderDebugShell({ intervalMs = 10000 } = {}) {
  return `<!doctype html>
<html lang="fr">
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
</style>
</head>
<body>
<header>
  <h1>🐛 gh notif · debug</h1>
  <span id="stamp">chargement…</span>
  <span class="spacer"></span>
  <a href="/">← retour aux tableaux</a>
</header>
<main id="content"><p class="empty">chargement…</p></main>
<script>
  var INTERVAL = ${Number(intervalMs)};
  var content = document.getElementById('content');
  var stamp = document.getElementById('stamp');
  function load() {
    fetch('/debug-fragment').then(function (r) { return r.text(); }).then(function (html) {
      content.innerHTML = html;
      stamp.textContent = 'maj ' + new Date().toLocaleTimeString('fr-FR');
    }).catch(function () { stamp.textContent = 'hors ligne — nouvelle tentative…'; });
  }
  load();
  setInterval(load, INTERVAL);
</script>
</body>
</html>`;
}
