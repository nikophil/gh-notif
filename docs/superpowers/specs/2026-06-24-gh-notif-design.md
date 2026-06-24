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

- **Toute mise à jour de la PR elle-même : git push, nouveau commit, changement d'état de la CI,
  merge/close, changement de label/assignee.** C'est une contrainte forte : ces événements ne
  doivent jamais apparaître, même sur mes propres PR.
- Quelqu'un d'autre review une PR où je suis juste reviewer.
- Quelqu'un d'autre commente (hors réponse à moi) une PR où je suis juste reviewer.

On ne traite **que les PullRequest** : tout thread dont `subject.type` ≠ `PullRequest` (Issue,
Release, Discussion, etc.) est ignoré, y compris les mentions sur des issues.

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
| `ci_activity`, `state_change`, `assign`, `push`, autres | **DROP** (mises à jour de la PR) | —             | non                              |

> **Garde-fou explicite sur les mises à jour de PR.** Un thread n'est gardé que si sa `reason`
> est dans la liste blanche `{review_requested, mention, team_mention, author, comment,
> subscribed, manual}`. Tout le reste est droppé. De plus, pour `author` (ma PR) on ne garde que
> si le **dernier événement est un commentaire/review d'une autre personne** — un push, un commit
> ou un changement d'état CI sur ma propre PR ne déclenche aucune notif. La `reason: author`
> accompagnée d'un `subject` sans nouveau commentaire (pas de `latest_comment_url`, ou
> `latest_comment_url` == URL de la PR) est traitée comme une mise à jour → DROP.

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
  → https://github.com/owner/repo/pull/123
💬 Mentions (1)
  owner/repo #120  Titre  — mention de @alice
  → https://github.com/owner/repo/pull/120#discussion_r456
📥 Activité sur tes PR (3)
  owner/repo #118  Titre  — @bob a commenté
  → https://github.com/owner/repo/pull/118#issuecomment_789
↩️ Réponses à tes commentaires (1)
  owner/repo #115  Titre  — @carol t'a répondu
  → https://github.com/owner/repo/pull/115#discussion_r321
──────────────────────────────
📋 Reviews en attente (4)
  owner/repo #98   Titre  (en attente depuis 3j)
  → https://github.com/owner/repo/pull/98
```

**Les liens sont obligatoires** : chaque item affiche une URL cliquable menant **directement** à
la bonne cible — la PR pour une review demandée / review en attente, et l'**ancre du commentaire
ou du thread précis** (`#discussion_r…` pour un review-comment, `#issuecomment_…` pour un
commentaire de conversation) pour les mentions, l'activité et les réponses. On construit ces URLs
à partir du champ `html_url` des commentaires récupérés (l'API notifications ne donne qu'une URL
API ; il faut résoudre le `latest_comment_url` ou le commentaire concerné pour obtenir le
`html_url` ancré). Les terminaux modernes rendent les URLs cliquables ; on peut aussi utiliser les
hyperliens OSC 8 si le terminal les supporte.

## Notifications desktop (`--watch`)

Chaque nouvel item donne un `notify-send` dont le **titre dit le motif** (pourquoi on est
notifié) et le corps donne le contexte + le lien. Le motif découle de la catégorie :

| Catégorie                   | Titre de la notif desktop          | Corps                                  |
| --------------------------- | ---------------------------------- | -------------------------------------- |
| 🔍 Review demandée           | `Nouvelle PR à review`             | `owner/repo #123 — Titre`              |
| 💬 Mention                   | `@alice t'a mentionné`             | `owner/repo #120 — Titre`              |
| 📥 Activité sur ta PR        | `@bob a commenté ta PR`            | `owner/repo #118 — Titre`              |
| ↩️ Réponse à ton commentaire | `@carol t'a répondu`               | `owner/repo #115 — Titre`              |

Le `notify-send` reçoit aussi l'URL cliquable (dans le corps) ; selon le daemon de notif, on peut
ajouter une action « Ouvrir » qui lance le lien. À défaut, l'URL en clair dans le corps suffit.

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
- Les cas « don't » : **push / nouveau commit / changement d'état CI / merge (mise à jour de PR,
  même sur ma propre PR) → DROP**, autre review sur PR où je suis reviewer → DROP, commentaire
  général sur PR où je suis reviewer → DROP.
- Filtrage par `subject.type` : un thread `Issue` / `Release` / `Discussion` → DROP.
- Détection de réponse stricte : réponse sous mon commentaire (KEEP) vs commentaire général (DROP)
  vs ma propre réponse (DROP).
- Dédup d'état : item déjà vu (pas de re-notif) vs `updated_at` plus récent (re-notif).

## Hors scope v1

- Marquer comme lu depuis l'extension (`--mark-read`).
- Service systemd permanent (le `--watch` ponctuel suffit ; on pourra l'emballer plus tard).
- **Tout ce qui n'est pas une PullRequest** (issues, releases, discussions) — y compris les
  mentions sur des issues : hors scope.
