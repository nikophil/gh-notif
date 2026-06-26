# Notification d'approbation + badge « prête à merger »

## Contexte

`gh notif` surface l'activité GitHub à laquelle réagir, mais **n'alerte pas** quand
une de mes PR reçoit une approbation. Deux besoins :

1. Être **notifié** dès qu'un approve arrive sur une de mes PR.
2. Quand la PR atteint **≥ 2 approbations**, ajouter `🎉 prête à merger` à la notif.

## Constats qui cadrent le design

- Les `reviews` (`{author.login, state, submittedAt}`) sont **déjà récupérées** par
  `getPullDetailsBatch` pour toutes mes PR ouvertes, et `countApprovals` en tire déjà le
  compteur de la colonne ✅. → Détection **gratuite** (zéro requête GitHub en plus).
- `--watch` ET `--serve` envoient déjà des notifs desktop (notify-send) via
  `data.notifications` + dédup disque `state.js`. Mais un approve n'y passe pas : ces items
  viennent des *threads de notification*, pas des `reviews`. → Nouveau type d'évènement.
- `reviews` n'a pas d'id de review → la clé de dédup d'une approbation est
  `repo#number:login:submittedAt` (stable, unique).

## Décisions

- **Surfaces** : notif desktop (notify-send, `--watch`/`--serve`) **+** badge persistant
  `🎉` dans le tableau « Tes PR ouvertes » (terminal + web, donc aussi en one-shot).
- **Périmètre** : mes PR à l'état **`open`** uniquement. Une approbation sur une PR draft /
  mergée / fermée ne notifie pas et n'affiche pas le badge (« prête à merger » n'a pas de
  sens autrement, et ça évite le bruit type #7014).
- **Seuil** : `READY_THRESHOLD = 2` (constante). Le badge et le suffixe `🎉` apparaissent
  quand le nombre d'approbations courantes ≥ 2.
- **Anti-rafale au démarrage (approche A — mémoire par process)** : au 1er poll, on
  enregistre silencieusement toutes les approbations actuelles dans un `Set` (pas de notif) ;
  aux polls suivants, toute approbation absente du `Set` → notif. Pas d'état disque (un
  redémarrage ré-amorce, ce qui est acceptable : on n'était pas en train de regarder).

## Architecture

### `src/approvals.js` (nouveau module pur)
- `approvalsOf(reviews) → [{login, submittedAt}]` : reviewers dont la *dernière* review est
  `APPROVED`. `countApprovals` (collect.js) devient `approvalsOf(reviews).length`.
- `approvalKey(repo, number, login, submittedAt) → string`.
- `READY_THRESHOLD = 2`, `isReady(count) → bool`.
- `newApprovals(events, seen) → events[]` : renvoie les évènements dont la clé est absente de
  `seen` (Set), **sans muter `seen`** (le caller décide d'amorcer ou de notifier+marquer).

### `src/collect.js`
- `collectPRs` renvoie en plus `data.approvalEvents` : pour chaque PR **à moi et `open`**, un
  évènement par approbation `{repo, number, title, actor: login, url, submittedAt, count}`
  (`count` = nb total d'approbations de la PR). Les lignes `mine` gardent `approvals` (compteur)
  inchangé.

### `src/filter.js` + `src/notify.js`
- `CATEGORY.APPROVAL` ajouté (**pas** dans `TRIGGER_FOR` → ne crée pas de ligne).
- `notifyMessage` : titre `@<actor> a approuvé ta PR`, suffixe ` 🎉 prête à merger` si
  `item.count >= READY_THRESHOLD`. `watchEventLine` (journal `-v`) en hérite.

### `--watch` (gh-notif) et `--serve` (serve.js)
- Chacun tient `seenApprovals` (Set) + `primedApprovals` (bool), en mémoire.
  1er poll : remplir `seen` sans notifier. Polls suivants : `newApprovals(events, seen)` →
  pour chacun `sendNotification(item)` (+ journal en `-v`), puis ajout à `seen`.

### Badge dans les tableaux (état dérivé, indépendant des notifs)
- Terminal `mineTable` (render.js) : colonne ✅ → `2 🎉` quand `state==='open' && approvals>=2`.
- Web `mineTable` (html.js) : `approvalsCell` ajoute `🎉` (`title="Prête à merger"`), mêmes
  conditions.

### One-shot `gh notif`
- Pas de notif push (instantané), mais le badge `🎉` s'affiche.

## Tests (TDD)
- `test/approvals.test.js` : `approvalsOf` (latest wins, ignore COMMENTED/CHANGES_REQUESTED),
  `approvalKey`, `newApprovals` (diff/seed), `isReady`.
- `test/notify.test.js` : message `APPROVAL` + suffixe `🎉` au-delà du seuil, absent en dessous.
- `test/collect.test.js` : `data.approvalEvents` (open seulement, count correct, exclut
  draft/merged et les PR des autres).
- `test/render.test.js` : badge `🎉` si open & ≥2 ; absent si <2 / draft / merged ; alignement.
- `test/html.test.js` : badge `🎉` + `title` ; absent hors conditions.

## Docs
- `README.md` : section « Approbations / prête à merger ».
- `docs/ARCHITECTURE.md` : flux approbation (détection gratuite, seed en mémoire, seuil).

## Hors périmètre
- Seuil configurable / lecture des règles de protection de branche (YAGNI : seuil fixe à 2).
- Badge sur les PR des autres (la demande porte sur « mes PR »).
- Survie de l'état d'approbation aux redémarrages (approche B/disque écartée).
- Notifs sur changes-requested / dismiss (la demande porte sur les approbations).
