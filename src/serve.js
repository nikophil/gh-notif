// Mode `gh notif --serve` : un petit serveur HTTP local (node:http, zéro
// dépendance) qui sert la même donnée que `gh notif` dans une page web
// auto-rafraîchie. Une seule boucle de poll alimente un snapshot en mémoire ;
// les requêtes HTTP le servent (plusieurs onglets ≠ plus d'appels GitHub).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { collectPRs } from './collect.js';
import { renderShell, renderFragment, escapeHtml } from './html.js';

const POLL_SECONDS = 60;
const CLIENT_POLL_MS = 10000; // rythme de re-fetch du fragment côté navigateur

// Routing pur (aucune I/O) → { status, type, body }. Testable sans socket.
export function handleRequest(pathname, snapshot, { now, intervalMs } = {}) {
  if (pathname === '/') {
    return { status: 200, type: 'text/html; charset=utf-8', body: renderShell({ intervalMs }) };
  }
  if (pathname === '/fragment') {
    const body = snapshot.error
      ? `<p class="empty offline">⚠️ Erreur : ${escapeHtml(snapshot.error)}</p>`
      : renderFragment(snapshot.data ?? { mine: [], others: [] }, { now });
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

// Démarre la boucle de poll + le serveur HTTP. Bloque (le process tourne jusqu'à
// Ctrl-C). Renvoie le server pour permettre une fermeture propre en test.
export function serve({ gh, me, scope, all = false, port = 7777, intervalSeconds = POLL_SECONDS } = {}) {
  const snapshot = { data: { mine: [], others: [] }, updatedAt: null, error: null };

  const refresh = async () => {
    try {
      snapshot.data = await collectPRs(gh, me, { all, scope });
      snapshot.updatedAt = Date.now();
      snapshot.error = null;
    } catch (err) {
      snapshot.error = err.message;
    }
  };
  refresh();
  const timer = setInterval(refresh, intervalSeconds * 1000);

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const { status, type, body } = handleRequest(pathname, snapshot, {
      now: Date.now(),
      intervalMs: CLIENT_POLL_MS,
    });
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });

  server.on('close', () => clearInterval(timer));
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    process.stderr.write(`🔔 gh notif --serve · ${url} · Ctrl-C pour arrêter\n`);
    openBrowser(url);
  });
  return server;
}
