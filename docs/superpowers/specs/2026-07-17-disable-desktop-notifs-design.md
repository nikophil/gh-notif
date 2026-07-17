# Checkbox « couper les notifications desktop » (mode `--serve`)

## Contexte

En `--serve`, la boucle de poll pousse une **notification desktop** (`notify-send`) pour chaque
nouvel évènement (comme `--watch`). Il n'existait aucun moyen de **couper** ces notifs sans quitter
le serveur. Besoin : une **case à cocher** dans l'interface web pour les (dés)activer à chaud.

## Constats qui cadrent le design

- L'« interface » cliquable, c'est le **mode web `--serve`** : le terminal `--watch` est 100 %
  clavier, sans surface cliquable. → Périmètre = `--serve` uniquement.
- Les notifs sont envoyées **côté serveur** dans `notifyNew(data)` (closure de `serve()`), pas côté
  navigateur. → La case doit piloter un **flag serveur**, pas un état purement client.
- `notifyNew` fait deux choses avant de notifier : `diffApprovals` remplit toujours `seenApprovals`,
  et `markSeen(state, item)` marque chaque item **avant** `sendNotification`. → Gater uniquement les
  deux `sendNotification` suffit à obtenir « marquer vu en silence » sans réécrire le seed.
- Persistance déjà cadrée par `state.js` / `hidden.js` (`~/.local/state/gh-notif/*.json`,
  `XDG_STATE_HOME`). → Un module jumeau `prefs.js` pour la préférence.

## Décisions

- **Persistance** : sur disque (`prefs-v1.json`), le choix **survit à un redémarrage**. Notifs
  **activées par défaut** (seul un `notify: false` explicite les coupe).
- **Comportement pendant l'off** : « marquer vu en silence » — on continue de consommer/mémoriser les
  évènements, on saute seulement l'envoi. Recocher ne provoque **aucune rafale** (cohérent avec le
  seed silencieux du 1er poll).
- **Widget** : une vraie `<input type="checkbox">` (demande explicite), placée dans l'en-tête
  (`.controls`), donc **hors `#content`** → elle survit d'elle-même aux refresh du fragment.
- **Hors périmètre** : `--watch` (clavier) n'est pas touché.

## Architecture

### `src/prefs.js` (nouveau module pur + I/O JSON, calqué sur `state.js`)
- `prefsPath()` → `~/.local/state/gh-notif/prefs-v1.json` (respecte `XDG_STATE_HOME`).
- `loadPrefs(path)` → objet avec **défauts** appliqués (`{ notify: true }`) ; fichier absent/corrompu
  → défaut. Les défauts complètent aussi un fichier partiel.
- `savePrefs(path, prefs)`.
- `isNotifyEnabled(prefs)` → `prefs.notify !== false` (nommé ainsi pour ne pas entrer en collision
  avec le flag local `notifyEnabled` de `serve.js`).

### `src/serve.js`
- Amorçage : `let notifyEnabled = isNotifyEnabled(loadPrefs(prefsPath()))`.
- `notifyNew` : les **deux** `sendNotification` (approbations + items) sont gatés par `notifyEnabled` ;
  `diffApprovals` / `markSeen` / `saveState` restent inconditionnels.
- Route `POST /notify?enabled=0|1` : met à jour le flag, `savePrefs`, répond **`204 No Content`**.
- `handleRequest('/')` reçoit et propage `notifyEnabled` à `renderShell`.

### `src/html.js`
- `renderShell({ …, notifyEnabled = true })` : ajoute `<label id="notify-label"><input type="checkbox"
  id="notify" [checked]> 🔔 notifs</label>` dans `.controls`, un peu de CSS d'alignement (aucun impact
  sur `displayWidth`/alignement terminal — rendu navigateur), et un handler `change` qui
  `fetch('/notify?enabled=…', {method:'POST'})` sans remplacer `#content`.

## Tests
- `test/prefs.test.js` : `prefsPath`/`XDG`, défauts (absent, corrompu, clés manquantes), round-trip,
  `isNotifyEnabled`.
- `test/html.test.js` : `renderShell` — case cochée/décochée selon `notifyEnabled`, cochée par défaut.
- `test/serve.test.js` : `handleRequest('/')` propage l'état ; intégration `POST /notify` (204,
  reflet dans la page, persistance disque via `loadPrefs`).
