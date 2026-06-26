// Mode `gh notif --serve` : un petit serveur HTTP local (node:http, zéro
// dépendance) qui sert la même donnée que `gh notif` dans une page web
// auto-rafraîchie et interactive (masquage, filtre org/repo, rafraîchissement
// manuel). Une seule boucle de poll alimente un snapshot en mémoire ; les
// requêtes HTTP le servent (plusieurs onglets ≠ plus d'appels GitHub). Comme
// `--watch`, chaque nouvel évènement pousse une notification desktop.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { collectPRs } from './collect.js';
import { CATEGORY } from './filter.js';
import { hiddenPath, loadHidden, saveHidden, toggleHidden, isHidden, keyOf } from './hidden.js';
import { statePath, loadState, saveState, isNew, markSeen } from './state.js';
import { sendNotification } from './notify.js';
import { isRateLimitError, nextBackoffSeconds } from './ratelimit.js';
import { renderShell, renderFragment, escapeHtml } from './html.js';

const POLL_SECONDS = 60;
const CLIENT_POLL_MS = 10000; // rythme de re-fetch du fragment côté navigateur
const BACKOFF_CAP = 600; // plafond du recul en cas de rate-limit (10 min)

// Valeur du champ de scope → objet scope (même sémantique que --org/--repo).
// Vide → null (tout). Contient « / » → repo (owner/name). Sinon → org.
export function parseScope(value) {
  const v = (value || '').trim();
  if (!v) return null;
  return v.includes('/') ? { type: 'repo', value: v } : { type: 'org', value: v };
}

// Libellé d'un scope pour préremplir le champ de saisie ('' = tout).
export function scopeLabel(scope) {
  return scope ? scope.value : '';
}

// Re-filtre others/hidden depuis les données en mémoire après un toggle, sans
// refetch GitHub (même logique que l'entrypoint terminal).
function recompute(data, hidden) {
  const all = [...(data.others ?? []), ...(data.hidden ?? [])];
  const others = all.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = all.filter((r) => isHidden(hidden, keyOf(r)));
  return { ...data, others, hidden: hiddenRows, hiddenCount: hiddenRows.length };
}

// Routing des lectures (GET) — pur, aucune I/O. Testable sans socket.
export function handleRequest(pathname, snapshot, opts = {}) {
  const { now, intervalMs, showHidden, scope } = opts;
  if (pathname === '/') {
    return { status: 200, type: 'text/html; charset=utf-8', body: renderShell({ intervalMs, scopeLabel: scopeLabel(scope) }) };
  }
  if (pathname === '/fragment') {
    const body = snapshot.error
      ? `<p class="empty offline">⚠️ Erreur : ${escapeHtml(snapshot.error)}</p>`
      : renderFragment(snapshot.data ?? { mine: [], others: [] }, { now, showHidden });
    return { status: 200, type: 'text/html; charset=utf-8', body };
  }
  if (pathname === '/api/state') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(snapshot) };
  }
  return { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
}

// Ouvre le navigateur sur l'URL (best-effort, échec silencieux).
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* navigateur non ouvrable : on a déjà loggé l'URL */
  }
}

// Démarre la boucle de poll + le serveur HTTP. Le scope est mutable (filtre UI).
// Renvoie le server pour permettre une fermeture propre en test.
export function serve({ gh, me, scope: initialScope = null, all = false, port = 7777, intervalSeconds = POLL_SECONDS } = {}) {
  let scope = initialScope;
  const snapshot = { data: { mine: [], others: [] }, updatedAt: null, error: null };

  // Cache d'inspection réutilisé entre polls (thread inchangé = 0 requête).
  const inspectCache = new Map();
  let backoff = 0; // secondes ajoutées à l'intervalle après un rate-limit

  // Masquage : reflète l'état persisté (même vue que `gh notif`).
  const hiddenFile = hiddenPath();
  const hidden = loadHidden(hiddenFile);

  // Notifications desktop (comme --watch) : dédup par URL via state.js, seed
  // silencieux au 1er run (on n'alerte que sur ce qui arrive ensuite).
  const sPath = statePath();
  let primed = existsSync(sPath);
  const state = loadState(sPath);

  const notifyNew = (data) => {
    const items = data.notifications ?? [];
    if (!primed) {
      for (const item of items) markSeen(state, item);
      saveState(sPath, state);
      primed = true;
      return;
    }
    // PR encore ouvertes/pending (visibles, masquées ou miennes) : évite de
    // notifier une demande de review sur une PR déjà fermée/mergée (cf. #7004).
    const openKeys = new Set([...data.mine, ...data.others, ...(data.hidden ?? [])].map((r) => `${r.repo}#${r.number}`));
    const fresh = items.filter((i) => isNew(state, i));
    for (const item of fresh) {
      markSeen(state, item);
      if (item.category === CATEGORY.REVIEW_REQUEST && !openKeys.has(`${item.repo}#${item.number}`)) continue;
      sendNotification(item);
    }
    if (fresh.length > 0) saveState(sPath, state);
  };

  const refresh = async () => {
    try {
      const data = await collectPRs(gh, me, { all, scope, hidden, cache: inspectCache });
      if (data.hiddenChanged) saveHidden(hiddenFile, hidden);
      notifyNew(data);
      snapshot.data = data;
      snapshot.updatedAt = Date.now();
      snapshot.error = null;
      backoff = 0; // succès : on repart à l'intervalle normal
    } catch (err) {
      if (isRateLimitError(err.message)) {
        backoff = nextBackoffSeconds(backoff, intervalSeconds, BACKOFF_CAP);
        snapshot.error = `⏳ rate-limité par GitHub — reprise dans ${backoff}s`;
      } else {
        snapshot.error = err.message;
      }
    }
  };

  // Boucle reprogrammée par setTimeout (et non setInterval) pour intégrer le
  // backoff : le prochain poll est différé de `intervalSeconds + backoff`.
  let timer = null;
  const loop = async () => {
    await refresh();
    timer = setTimeout(loop, (intervalSeconds + backoff) * 1000);
  };
  loop();

  // Réponse standard après une action : le fragment courant (le client remplace
  // #content). `showHidden` est porté par la query pour préserver le mode.
  const fragmentResponse = (showHidden) =>
    snapshot.error
      ? `<p class="empty offline">⚠️ Erreur : ${escapeHtml(snapshot.error)}</p>`
      : renderFragment(snapshot.data ?? { mine: [], others: [] }, { now: Date.now(), showHidden });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const showHidden = url.searchParams.get('hidden') === '1';
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };

    if (req.method === 'POST') {
      if (pathname === '/refresh') {
        await refresh();
        return send(200, 'text/html; charset=utf-8', fragmentResponse(showHidden));
      }
      if (pathname === '/hide') {
        const key = url.searchParams.get('key');
        if (key) {
          toggleHidden(hidden, key, snapshot.data?.notifications ?? []);
          saveHidden(hiddenFile, hidden);
          snapshot.data = recompute(snapshot.data, hidden);
        }
        return send(200, 'text/html; charset=utf-8', fragmentResponse(showHidden));
      }
      if (pathname === '/scope') {
        scope = parseScope(url.searchParams.get('value'));
        await refresh();
        return send(200, 'text/html; charset=utf-8', fragmentResponse(showHidden));
      }
      return send(404, 'text/plain; charset=utf-8', 'Not found');
    }

    const { status, type, body } = handleRequest(pathname, snapshot, {
      now: Date.now(),
      intervalMs: CLIENT_POLL_MS,
      showHidden,
      scope,
    });
    send(status, type, body);
  });

  server.on('close', () => clearTimeout(timer));
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    process.stderr.write(`🔔 gh notif --serve · ${url} · Ctrl-C pour arrêter\n`);
    openBrowser(url);
  });
  return server;
}
