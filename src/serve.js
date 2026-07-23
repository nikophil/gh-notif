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
import { prefsPath, loadPrefs, savePrefs, isNotifyEnabled, themeOf } from './prefs.js';
import {
  parseScope, normalizeFavorites, addFavorite, removeFavorite,
  favoriteScopes, activeFavoriteOf, filterDataByScope, favoriteCounts, closedPRsUrl,
} from './favorites.js';
import { diffApprovals } from './approvals.js';
import { normalizeSort, toggleSort, sortRows, SORT_KEYS } from './sort.js';
import { sendNotification } from './notify.js';
import { isRateLimitError, nextBackoffSeconds } from './ratelimit.js';
import { startSpinner } from './spinner.js';
import { renderShell, renderFragment, renderLoading, renderDebug, renderDebugShell, renderFavorites, escapeHtml } from './html.js';

const POLL_SECONDS = 60;
const BACKOFF_CAP = 600; // plafond du recul en cas de rate-limit (10 min)
const REFRESH_MIN_AGE_MS = 10_000; // débounce de POST /refresh (voir shouldRefresh)

// `parseScope` vit dans favorites.js (module pur, sans node:http) car le CLI et
// les favoris en ont besoin ; ré-exporté ici où il a toujours été consommé.
export { parseScope };

// Libellé d'un scope pour préremplir le champ de saisie ('' = tout).
// En mode favoris, `scope` est un TABLEAU (l'union) : le champ reste vide, ce
// sont les chips qui portent l'information.
export function scopeLabel(scope) {
  return scope && !Array.isArray(scope) ? scope.value : '';
}

// Débounce du POST /refresh : le client en envoie un à CHAQUE chargement de
// page (ctrl+R = « rafraîchis vraiment »), donc on ne re-poll GitHub que si le
// snapshot a plus de `minAgeMs` (sinon spammer ctrl+R = spammer GitHub, cf.
// rate-limit §11). `updatedAt` null (1er poll pas fini) → toujours poller.
export function shouldRefresh(updatedAt, now, minAgeMs = REFRESH_MIN_AGE_MS) {
  return updatedAt == null || now - updatedAt >= minAgeMs;
}

// Re-filtre others/hidden depuis les données en mémoire après un toggle, sans
// refetch GitHub (même logique que l'entrypoint terminal).
function recompute(data, hidden) {
  const all = [...(data.others ?? []), ...(data.hidden ?? [])];
  const others = all.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = all.filter((r) => isHidden(hidden, keyOf(r)));
  return { ...data, others, hidden: hiddenRows, hiddenCount: hiddenRows.length };
}

// Corps HTML du fragment selon l'état du snapshot : erreur → bannière échappée ;
// pas encore de données (1er poll en cours) → spinner ; sinon → les tableaux.
// ⚠️ Le snapshot contient les données de l'UNION des favoris ; le filtre du
// favori actif s'applique ICI, au rendu — jamais à la collecte (cf. §14).
function fragmentBody(snapshot, { now, showHidden, viewScope = null, closedUrl = null, sort = null } = {}) {
  if (snapshot.error) return `<p class="empty offline">⚠️ Erreur : ${escapeHtml(snapshot.error)}</p>`;
  if (!snapshot.updatedAt) return renderLoading();
  let data = filterDataByScope(snapshot.data ?? { mine: [], others: [] }, viewScope);
  // Tri d'affichage du tableau « autres » (les masquées suivent, cohérence en
  // mode ?hidden=1). `sort` absent → ordre de collecte inchangé (compat).
  if (sort) data = { ...data, others: sortRows(data.others, sort), hidden: sortRows(data.hidden, sort) };
  return renderFragment(data, { now, showHidden, closedUrl, sort });
}

// Scope(s) que la vue AFFICHE, pour contextualiser le lien « fermées ↗ » :
// ad-hoc > favori actif > union des favoris > null (tout GitHub). Distinct de
// `viewScope` (filtre d'affichage), qui est nul en ad-hoc (collecte déjà ciblée)
// et nul sur « tous » (l'union est déjà collectée).
function linkScopes({ scope = null, activeFav = null, favorites = [] } = {}) {
  return scope ?? parseScope(activeFav) ?? favoriteScopes(favorites);
}

// Corps du fragment de debug (verdict du pipeline) — même gestion erreur/chargement.
function debugBody(snapshot, { now, viewScope = null } = {}) {
  if (snapshot.error) return `<p class="empty offline">⚠️ Erreur : ${escapeHtml(snapshot.error)}</p>`;
  if (!snapshot.updatedAt) return renderLoading();
  const data = filterDataByScope(snapshot.data ?? {}, viewScope);
  return renderDebug(data?.debug ?? [], { now });
}

// Routing des lectures (GET) — pur, aucune I/O. Testable sans socket.
export function handleRequest(pathname, snapshot, opts = {}) {
  const {
    now, intervalMs, showHidden, scope, notifyEnabled = true, theme = 'auto',
    favorites = [], activeFav = null, adhoc = false, sort = null,
  } = opts;
  // Filtre d'affichage : le favori actif, sauf en mode ad-hoc (le scope saisi
  // pilote déjà la collecte, re-filtrer serait redondant).
  const viewScope = adhoc ? null : parseScope(activeFav);
  // Lien « fermées ↗ » contextualisé sur ce que la vue affiche.
  const closedUrl = closedPRsUrl(linkScopes({ scope, activeFav, favorites }));
  // Compteurs des puces = activité des autres par scope, sur l'UNION brute.
  const counts = favoriteCounts(favorites, snapshot.data?.others);
  if (pathname === '/') {
    return { status: 200, type: 'text/html; charset=utf-8', body: renderShell({ intervalMs, scopeLabel: scopeLabel(scope), notifyEnabled, theme, favorites, activeFav, adhoc, counts }) };
  }
  if (pathname === '/fragment') {
    return { status: 200, type: 'text/html; charset=utf-8', body: fragmentBody(snapshot, { now, showHidden, viewScope, closedUrl, sort }) };
  }
  // Poll unifié du client : tableaux filtrés + barre de favoris (compteurs à jour)
  // + updatedAt (le client sonde jusqu'à ce qu'il change après un ajout/retrait).
  if (pathname === '/view') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({
      chips: renderFavorites(favorites, activeFav, { adhoc, counts }),
      fragment: fragmentBody(snapshot, { now, showHidden, viewScope, closedUrl, sort }),
      updatedAt: snapshot.updatedAt,
    }) };
  }
  if (pathname === '/api/state') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(snapshot) };
  }
  // Mode debug (always-on) : page autonome + son fragment + JSON brut.
  if (pathname === '/debug') {
    return { status: 200, type: 'text/html; charset=utf-8', body: renderDebugShell({ intervalMs }) };
  }
  if (pathname === '/debug-fragment') {
    return { status: 200, type: 'text/html; charset=utf-8', body: debugBody(snapshot, { now, viewScope }) };
  }
  if (pathname === '/api/debug') {
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(snapshot.data?.debug ?? []) };
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
//
// Deux notions à ne pas confondre (cf. ARCHITECTURE.md §14) :
//  - `scope` (mode ad-hoc) ou l'union des favoris = ce qu'on COLLECTE ;
//  - `activeFav` = simple filtre d'AFFICHAGE, changé sans aucune requête.
export function serve({ gh, me, scope: initialScope = null, all = false, port = 7777, intervalSeconds = POLL_SECONDS, open = true } = {}) {
  // `scope` non nul ⇒ mode ad-hoc : un scope saisi (--org/--repo ou champ web)
  // prime sur les favoris, qui deviennent purement décoratifs (chips grisées).
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

  // Préférences UI persistées sur disque. On garde l'objet `prefs` en mémoire et
  // on le mute+sauve EN ENTIER (sinon un POST /notify écraserait la clé `theme`, et
  // inversement — bug de clé perdue). notify : notifs desktop (checkbox).
  // theme : skin CSS (auto/light/dark, switcher). Pilotés par POST /notify & /theme.
  const prefsFile = prefsPath();
  const prefs = loadPrefs(prefsFile);
  let notifyEnabled = isNotifyEnabled(prefs);
  let theme = themeOf(prefs);
  let sort = normalizeSort(prefs.sort); // tri du tableau « autres » (persisté)
  // favorites : scopes épinglés (persistés). activeFav : celui qu'on regarde
  // (null = tous). collectScope : ce qu'on demande réellement à GitHub.
  let favorites = normalizeFavorites(prefs.favorites);
  let activeFav = activeFavoriteOf(prefs, favorites);
  const collectScope = () => (scope ? scope : favoriteScopes(favorites));

  // Approbations sur mes PR : état en mémoire (par process), indépendant de l'état
  // disque des notifs. 1er poll = amorçage silencieux (pas de rafale au démarrage).
  const seenApprovals = new Set();
  let primedApprovals = false;

  const notifyNew = (data) => {
    // Approbations d'abord (indépendant du seed disque ci-dessous) : un approve
    // nouveau → notif desktop, comme --watch. Voir approvals.js / spec.
    // diffApprovals mémorise TOUJOURS dans seenApprovals (même quand on ne notifie
    // pas) → désactiver les notifs = « marquer vu en silence », pas de rafale au
    // ré-activation.
    const freshApprovals = diffApprovals({ events: data.approvalEvents ?? [], seen: seenApprovals, primed: primedApprovals });
    primedApprovals = true;
    if (notifyEnabled) for (const e of freshApprovals) sendNotification({ ...e, category: CATEGORY.APPROVAL });

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
      markSeen(state, item); // toujours marqué vu, même notifs off (pas de rafale au ré-activation)
      if (!notifyEnabled) continue;
      if (item.category === CATEGORY.REVIEW_REQUEST && !openKeys.has(`${item.repo}#${item.number}`)) continue;
      sendNotification(item);
    }
    if (fresh.length > 0) saveState(sPath, state);
  };

  const refresh = async () => {
    const stop = startSpinner('Mise à jour…'); // spinner terminal (no-op hors TTY)
    try {
      // Collecte sur l'UNION des favoris (ou le scope ad-hoc). notifyNew reçoit
      // ces données brutes : c'est ce qui fait arriver les notifs desktop des
      // favoris qu'on ne regarde pas. Le filtrage se fait au rendu (fragmentBody).
      const data = await collectPRs(gh, me, { all, scope: collectScope(), hidden, cache: inspectCache });
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
    } finally {
      stop();
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

  // Réponse unifiée des actions (JSON {chips, fragment, updatedAt}) : la barre de
  // favoris vit dans le <header> (hors #content), on renvoie donc les deux
  // morceaux et le client les injecte séparément — les compteurs restent à jour.
  // (À l'inverse de /notify & /theme, dont le widget n'a rien à re-rendre → 204.)
  const currentView = (showHidden) => {
    const counts = favoriteCounts(favorites, snapshot.data?.others);
    return JSON.stringify({
      chips: renderFavorites(favorites, activeFav, { adhoc: !!scope, counts }),
      fragment: fragmentBody(snapshot, {
        now: Date.now(), showHidden,
        viewScope: scope ? null : parseScope(activeFav),
        closedUrl: closedPRsUrl(linkScopes({ scope, activeFav, favorites })),
        sort,
      }),
      updatedAt: snapshot.updatedAt,
    });
  };
  const json = 'application/json; charset=utf-8';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const showHidden = url.searchParams.get('hidden') === '1';
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };

    if (req.method === 'POST') {
      if (pathname === '/refresh') {
        // Débouncé : snapshot frais (< 10 s) → on répond la vue courante sans
        // toucher GitHub (le client force /refresh à chaque chargement de page).
        if (shouldRefresh(snapshot.updatedAt, Date.now())) await refresh();
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/hide') {
        const key = url.searchParams.get('key');
        if (key) {
          toggleHidden(hidden, key, snapshot.data?.notifications ?? []);
          saveHidden(hiddenFile, hidden);
          snapshot.data = recompute(snapshot.data, hidden);
        }
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/scope') {
        // Saisie manuelle → mode ad-hoc (les chips passent en grisé) ; champ vidé
        // → retour au mode favoris (ou tout GitHub si aucun favori).
        scope = parseScope(url.searchParams.get('value'));
        await refresh();
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/fav') {
        // Changement de favori actif = filtre d'affichage pur : AUCUN appel
        // GitHub… sauf si on sortait du mode ad-hoc (l'union n'est pas collectée).
        const value = (url.searchParams.get('value') || '').trim();
        activeFav = favorites.includes(value) ? value : null;
        prefs.activeFav = activeFav; // ⚠️ muter + réécrire EN ENTIER (sinon notify/theme perdus)
        savePrefs(prefsFile, prefs);
        if (scope) { scope = null; await refresh(); }
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/fav/add' || pathname === '/fav/rm') {
        const value = url.searchParams.get('value') || '';
        // Pas le droit d'épingler un scope qui n'existe pas sur GitHub (une
        // vérification rapide, ~1 requête). Tri-état : false → 400 net ; null
        // (réseau, rate-limit…) → fail-open, on n'empêche pas l'ajout à tort.
        if (pathname === '/fav/add' && typeof gh.scopeExists === 'function') {
          const s = parseScope(value);
          if (s && (await gh.scopeExists(s)) === false) {
            return send(400, 'text/plain; charset=utf-8', s.type === 'repo'
              ? `dépôt ${s.value} introuvable sur GitHub`
              : `org/utilisateur ${s.value} introuvable sur GitHub`);
          }
        }
        try {
          favorites = pathname === '/fav/add' ? addFavorite(favorites, value) : removeFavorite(favorites, value);
        } catch (err) {
          return send(400, 'text/plain; charset=utf-8', err.message);
        }
        activeFav = activeFavoriteOf({ activeFav }, favorites); // favori retiré → « tous »
        prefs.favorites = favorites;
        prefs.activeFav = activeFav;
        savePrefs(prefsFile, prefs);
        scope = null; // épingler/retirer, c'est vouloir la vue favoris
        // ⚠️ refresh en ARRIÈRE-PLAN : la réponse part tout de suite (la puce
        // apparaît sans attendre le poll) ; le client sonde /view jusqu'à ce que
        // updatedAt change pour voir compteurs et tableaux se mettre à jour.
        refresh().catch(() => {});
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/sort') {
        // Tri = état d'affichage pur : recompute local, AUCUN appel GitHub.
        const key = url.searchParams.get('key');
        if (!SORT_KEYS.includes(key)) return send(400, 'text/plain; charset=utf-8', `clé de tri inconnue : ${key ?? ''}`);
        sort = toggleSort(sort, key);
        prefs.sort = sort; // ⚠️ muter + réécrire EN ENTIER (sinon notify/theme perdus)
        savePrefs(prefsFile, prefs);
        return send(200, json, currentView(showHidden));
      }
      if (pathname === '/notify') {
        notifyEnabled = url.searchParams.get('enabled') !== '0';
        prefs.notify = notifyEnabled;
        savePrefs(prefsFile, prefs);
        // La case vit dans l'en-tête (hors #content) : pas besoin de re-rendre les
        // tableaux, un accusé suffit.
        return send(204, 'text/plain; charset=utf-8', '');
      }
      if (pathname === '/theme') {
        // Normalise (valeur inconnue → auto). Le switcher vit dans l'en-tête et
        // applique déjà data-theme côté client → un accusé suffit.
        theme = themeOf({ theme: url.searchParams.get('value') });
        prefs.theme = theme;
        savePrefs(prefsFile, prefs);
        return send(204, 'text/plain; charset=utf-8', '');
      }
      return send(404, 'text/plain; charset=utf-8', 'Not found');
    }

    const { status, type, body } = handleRequest(pathname, snapshot, {
      now: Date.now(),
      // Le rafraîchissement de la page suit le vrai intervalle de poll GitHub
      // (le re-fetch ne fait que relire le snapshot du serveur, 0 appel GitHub).
      intervalMs: intervalSeconds * 1000,
      showHidden,
      scope,
      notifyEnabled,
      theme,
      favorites,
      activeFav,
      adhoc: !!scope,
      sort,
    });
    send(status, type, body);
  });

  server.on('close', () => clearTimeout(timer));
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    process.stderr.write(`🔔 gh notif --serve · ${url} · Ctrl-C pour arrêter\n`);
    if (open) openBrowser(url);
  });
  return server;
}
