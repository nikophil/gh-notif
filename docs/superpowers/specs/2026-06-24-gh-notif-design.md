# gh-notif — design

Extension `gh` CLI qui donne des notifications GitHub filtrées avec la granularité que
l'inbox GitHub native ne permet pas. Usage perso (Linux, Node disponible).

## Objectif

Recevoir une notification **uniquement** pour :

1. Toute action de quelqu'un d'autre sur **mes** PR (review, commentaire de thread, commentaire direct).
2. Toute nouvelle demande de review.
3. Toute mention.
4. Toute **réponse à un de mes commentaires précis** (vraie réponse dans un fil de review inline).

Ne **pas** notifier pour :

- PR mise à jour (push) / activité CI.
- Quelqu'un d'autre review une PR où je suis juste reviewer.
- Quelqu'un d'autre commente (hors réponse à moi) une PR où je suis juste reviewer.

En complément, afficher la pile des **reviews en attente** (PR où je suis reviewer assigné et
pas encore review) — un état, pas un événement.

## Approche

Extension `gh` en **Node, zéro dépendance**. Un exécutable `gh-notif` (`#!/usr/bin/env node`).
On délègue auth + appels API + pagination à `gh api` via `child_process` → on hérite de
`gh auth`. Parsing JSON natif. Notifications desktop via `notify-send`.

Pourquoi pas Go (compilation), pas Bash (logique d'inspection de threads ignoble en jq) :
Node donne le JSON natif sans build, et `gh api` apporte la robustesse.

## Commandes

- `gh notif` — fetch + filtre + affiche la liste. Non-lues par défaut, `--all` inclut les lues.
  Affiche aussi la section « reviews en attente » en bas.
- `gh notif --watch` — boucle de poll (intervalle = header `X-Poll-Interval`, ~60s), diff contre
  l'état, `notify-send` pour chaque **nouvel** item, met à jour l'état. (Le `--watch` ne traite
  que les événements du flux `/notifications`, pas la pile « reviews en attente ».)
- `gh notif --pending` — n'affiche que les reviews en attente (raccourci ; c'est aussi dans le
  défaut).

## Structure du repo

```
gh-notif/
├── gh-notif              # entrypoint exécutable, parse les args, dispatch
├── src/
│   ├── github.js         # wrapper `gh api` (execFile) → JSON, pagination ; getCurrentUser,
│   │                     #   listNotifications, getReviewComments, searchReviewRequested
│   ├── filter.js         # moteur de filtrage (fonctions pures) — cœur testable
│   ├── state.js          # lecture/écriture état + dédup
│   ├── notify.js         # notify-send (fallback stdout si absent)
│   └── render.js         # affichage terminal groupé par catégorie
├── test/                 # node:test natif, fixtures JSON
├── package.json          # { "type": "module" }, aucune dependency
└── README.md
```

`gh-notif` importe `./src/*.js` en relatif, chemins résolus via `import.meta.url`.

## Moteur de filtrage (cœur)

Pour chaque thread renvoyé par `/notifications`, classification selon `reason` :

| `reason`                          | Décision                                   | Catégorie                  | Inspection                       |
| --------------------------------- | ------------------------------------------ | -------------------------- | -------------------------------- |
| `review_requested`                | KEEP                                       | 🔍 Review demandée          | non                              |
| `mention` / `team_mention`        | KEEP                                       | 💬 Mention                  | non                              |
| `author` (ma PR)                  | KEEP si dernier acteur ≠ moi               | 📥 Activité sur ma PR       | 1 fetch (auteur dernier event)   |
| `comment` / `subscribed` / `manual` | KEEP si réponse à un de **mes** commentaires | ↩️ Réponse à mon commentaire | fetch des review-comments        |
| `assign`, `ci_activity`, `state_change`, autres | DROP                          | —                          | non                              |

### Détection « réponse à un de mes commentaires » (granularité stricte, niveau thread)

Décidé : granularité **stricte au niveau du fil de review inline** (pas au niveau PR).

Pour un thread `comment`/`subscribed` sur une PR :

1. Fetch des review-comments : `GET /repos/{owner}/{repo}/pulls/{n}/comments` (paginé).
2. Reconstruire les fils via `in_reply_to_id` (chaque commentaire pointe vers son parent ; la
   racine est le commentaire sans `in_reply_to_id`).
3. Un fil « me concerne » s'il contient au moins un commentaire dont l'auteur est **moi**.
4. KEEP si, dans un fil qui me concerne, il existe un commentaire **plus récent que l'état**
   dont l'auteur ≠ moi. Sinon DROP.

Conséquence voulue : un commentaire général dans l'onglet conversation (commentaires « issue »,
non threadés) d'une PR où je suis juste reviewer → **DROP**. C'est exactement le bruit qu'on ne
veut pas. Les commentaires issue ne comptent donc pas comme « réponse à un thread » (ils sont
couverts uniquement via `mention` quand on m'@-mentionne).

### Filtrage « pas mes propres actions »

GitHub ne notifie normalement pas l'auteur de sa propre action, mais par sécurité : pour
`author`, si l'auteur du dernier événement == moi → DROP. Pour `comment`/`subscribed`, un
commentaire dont l'auteur == moi n'est jamais compté comme « réponse à moi ».

## Reviews en attente (search API)

Source distincte du flux notifications. Requête :
`gh api -X GET search/issues -f q="is:open is:pr review-requested:@me"` (ou équivalent
`gh search prs --review-requested=@me --state=open`), en excluant celles déjà review par moi.
État permanent : affichées même si « anciennes ». Section séparée en bas de `gh notif`.

## Flux de données

1. `me` = login courant (`gh api user`), mis en cache pour la session.
2. `gh api --paginate /notifications` → threads bruts (unread par défaut, `all` si `--all`).
3. Classification de chaque thread ; fetch ciblé `/pulls/{n}/comments` seulement pour
   `comment`/`subscribed`.
4. `list` → render groupé par catégorie + section reviews en attente.
   `watch` → diff contre état → `notify-send` des nouveaux.

## État & dédup (`watch`)

Fichier `~/.local/state/gh-notif/seen.json` (respecte `XDG_STATE_HOME`).
Map `thread_id → dernier updated_at notifié`. Un item est « nouveau » si son `updated_at` est
strictement postérieur à la valeur stockée (ou absente). Évite de re-notifier au poll suivant.

## Affichage

```
🔍 Reviews demandées (2)
  owner/repo #123  Titre de la PR
  ...
💬 Mentions (1)
📥 Activité sur tes PR (3)
↩️ Réponses à tes commentaires (1)
──────────────────────────────
📋 Reviews en attente (4)
  owner/repo #98   Titre  (en attente depuis 3j)
```

Chaque ligne : `repo #num  titre`, et un lien cliquable vers la PR/commentaire si possible.

## Gestion des erreurs

- `gh` absent ou non authentifié → message clair, exit 1.
- `notify-send` absent → fallback stdout, le `--watch` continue.
- Erreur réseau / rate-limit sur le fetch d'un thread → log, on garde le thread en mode dégradé
  (affiché sans la précision d'inspection) plutôt que de tout faire planter.
- Optimisation rate-limit (optionnelle) : `If-Modified-Since` sur `/notifications` pour des 304
  gratuits pendant le `--watch`.

## Tests

`filter.js` = fonctions pures → `node:test` natif sur fixtures JSON :

- Les 6 lignes du tableau de classification.
- Les 3 cas « don't » (push/CI, autre review sur PR où je suis reviewer, commentaire général sur
  PR où je suis reviewer).
- Détection de réponse stricte : réponse sous mon commentaire (KEEP) vs commentaire général (DROP)
  vs ma propre réponse (DROP).
- Dédup d'état : item déjà vu (pas de re-notif) vs `updated_at` plus récent (re-notif).

## Hors scope v1

- Marquer comme lu depuis l'extension (`--mark-read`).
- Service systemd permanent (le `--watch` ponctuel suffit ; on pourra l'emballer plus tard).
- Issues hors PR (focus PR ; les mentions sur issues restent captées via `reason: mention`).
