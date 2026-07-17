# Switcher de thème CSS (mode `--serve`)

## Contexte

La page web `--serve` était en thème **auto pur** (`@media prefers-color-scheme`). Besoin : un
**switcher clair / sombre / auto** dans l'en-tête, dont la sélection est **stockée dans le fichier de
préférences** (`prefs-v1.json`, déjà introduit pour la coupure des notifs).

## Constats qui cadrent le design

- Les prefs sont **server-side** et la coquille est rendue **server-side** → on peut poser le thème
  dès le rendu (`data-theme` sur `<html>`) : **pas de flash** de mauvais thème au chargement.
- `POST /notify` écrivait `savePrefs({ notify })` — ré-écrire une clé unique **écraserait** `theme`.
  → Il faut garder l'objet `prefs` complet en mémoire et le sauver en entier.
- CSS : `[data-theme="…"]` (spécificité 0,1,1) l'emporte sur `:root` (0,0,1) **même** dans une media
  query (les media queries n'ajoutent pas de spécificité) → override explicite fiable.

## Décisions

- **Valeurs** : `auto` (défaut, suit le système) | `light` | `dark`. Toute valeur inconnue → `auto`
  (validation `themeOf`, robustesse face à un fichier trafiqué).
- **Widget** : **boutons segmentés** (🌗 auto / ☀️ clair / 🌙 sombre), l'actif surligné via la classe
  `.on` déjà stylée. Dans l'en-tête, hors `#content` → survit aux refresh du fragment.
- **Application** : `data-theme` posé au rendu serveur **et** mis à jour côté client immédiatement
  (pas de reload) ; `POST /theme` persiste en tâche de fond (réponse `204`).
- **Persistance** : même fichier `prefs-v1.json`, objet muté+sauvé **en entier** (jamais clé par clé).
- **Hors périmètre** : la page `/debug` reste en `auto` système (secondaire).

## Architecture

### `src/prefs.js`
- `DEFAULTS.theme = 'auto'` ; `themeOf(prefs)` → `light|dark|auto` (inconnu/absent → `auto`).

### `src/serve.js`
- `const prefs = loadPrefs(...)`, puis `let notifyEnabled = isNotifyEnabled(prefs)` et
  `let theme = themeOf(prefs)`. Chaque action mute `prefs` et `savePrefs(prefs)` **complet**.
- `POST /theme?value=…` → `themeOf` normalise → maj `theme` + persistance → `204`.
- `handleRequest('/')` propage `theme` à `renderShell`.

### `src/html.js`
- `LIGHT_VARS`/`DARK_VARS` : **source unique** des variables Primer, réutilisée dans 4 sélecteurs
  (`:root`, `@media dark :root[data-theme="auto"]`, `[data-theme="light"]`, `[data-theme="dark"]`).
- `renderShell({ theme })` : `data-theme` sur `<html>`, switcher segmenté (bouton courant `.on`),
  handler JS `click` → applique `data-theme` + bascule `.on` + `POST /theme`.

## Tests
- `test/prefs.test.js` : `themeOf` (valides / inconnu / absent / nul), défauts incluant `theme`.
- `test/html.test.js` : `data-theme` selon la pref, 4 blocs CSS, switcher 3 boutons + actif `.on`.
- `test/serve.test.js` : `handleRequest('/')` propage le thème ; intégration `POST /theme`
  (204, reflet, persistance, **notify préservé**, valeur invalide → `auto`).
