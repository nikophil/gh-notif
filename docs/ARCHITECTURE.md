# Architecture — gh-notif (doc pour agents)

> Lis ce document **avant toute modification**. Il décrit les modules, le flux de données, et
> surtout les **décisions non-évidentes** (les pièges qui ont coûté des bugs). La spec de design
> complète est dans `docs/superpowers/specs/2026-06-24-gh-notif-design.md`.

## Vue d'ensemble

Extension `gh` CLI en **Node (ESM), zéro dépendance npm**. Un seul exécutable `gh-notif` qui
importe des modules `src/*.js`. Tous les accès GitHub passent par `gh` (via `child_process`), ce
qui réutilise l'auth de l'utilisateur. Tests avec le runner natif `node:test` (`npm test`).

## Modules et responsabilités

| Fichier | Rôle | Pur / testable ? |
|---------|------|------------------|
| `gh-notif` | Entrypoint : parse les args, résout le scope, dispatch `runList` / `runWatch`. | non (I/O, boucle) |
| `src/github.js` | Wrapper fin autour de `gh` (`makeGh(runner)`), `runner` injectable. Renvoie du JSON brut. | oui via runner stub |
| `src/filter.js` | **Cœur** : `classify()` (règles de filtrage), `findReplyToMe()`, helpers. Fonctions pures. | oui |
| `src/collect.js` | Orchestration : agrège notifications + recherches en PRs, récupère les détails, scope. | oui via gh stub |
| `src/state.js` | Persistance + déduplication du `--watch`. | oui |
| `src/notify.js` | Notifs desktop (`notify-send`) + ligne d'évènement terminal. | oui via spawn stub |
| `src/render.js` | Tableaux encadrés alignés, couleur, liens OSC 8, helpers d'affichage. | oui |

Chaque module a une responsabilité claire ; la logique difficile vit dans des **fonctions pures**
testées sur fixtures (pas d'appel réseau en test).

## Flux de données (`gh notif`)

```
gh-notif (parse args → scope)
  └─ runList → collectPRs(gh, me, {all, scope})
       ├─ collectNotifications  → /notifications, filtre PR + scope, inspectThread, classify → Items
       ├─ collectPending        → search review-requested:@me (+ qualifier scope)
       ├─ collectAuthored       → search author:@me        (+ qualifier scope)
       ├─ regroupe par PR (repo#number), agrège les triggers
       ├─ getPullDetails par PR (gh pr view --json …), concurrence limitée à 8
       └─ split mine / others selon l'auteur de la PR
  └─ renderList({mine, others}) → deux tableaux
```

`--watch` : `runWatch` boucle sur `collectNotifications` (pas les recherches), diff via `state.js`,
`sendNotification` + `watchEventLine` par nouvel item, puis `countdown` jusqu'au prochain poll.

## Formes de données

- **Thread** (`/notifications`) : `{ id, reason, updated_at, subject:{title,url,latest_comment_url,type}, repository:{full_name} }`
- **Item** (sortie de `classify`) : `{ category, actor, url, repo, number, title, threadId, updatedAt }`
- **Row** (sortie de `collectPRs`) : `{ repo, number, url, title, triggers:[…], author, createdAt, additions, deletions, ci }`
- **scope** : `null` (tout) | `{ type:'org', value }` | `{ type:'repo', value:'owner/name' }`

## Décisions non-évidentes (⚠️ pièges)

1. **La `reason` GitHub est « collante ».** Une PR où tu as été mentionné garde `reason: mention`
   même quand l'évènement réel suivant est une réponse de quelqu'un d'autre. Donc `classify` ne fait
   **pas** confiance à la `reason` seule : il teste `findReplyToMe` **en premier** (signal le plus
   précis → `THREAD_REPLY`), et ne retombe sur mention/author qu'ensuite. `inspectThread` récupère
   **toujours** les review-comments, pas seulement pour `reason: comment`.

2. **GitHub aplatit les fils de review.** Toutes les réponses d'un fil pointent vers le commentaire
   **racine** (`in_reply_to_id` = racine), pas vers le commentaire précédent. `findReplyToMe`
   regroupe par racine, puis renvoie le commentaire d'un autre auteur **postérieur à mon dernier
   commentaire** du fil (pas juste « dans un fil où je suis »).

3. **Dédup du `--watch` par URL d'évènement, jamais par `updated_at`.** GitHub bump l'`updated_at`
   du thread à chaque activité ; déduper dessus re-notifie en boucle (re-« review demandée » dès
   qu'un autre commente, double-notif du même commentaire). On déduplique sur l'URL précise
   (`item.url`). Fichier d'état versionné `seen-v2.json` (un changement de clé impose un nouveau nom
   pour éviter un flot au passage).

4. **Premier run de `--watch` = seed silencieux.** Si le fichier d'état n'existe pas, on marque tout
   le backlog « vu » sans notifier ; on n'alerte que sur ce qui arrive ensuite.

5. **Largeur d'affichage des emojis (`render.js#displayWidth`).** L'alignement des tableaux en
   dépend entièrement. Règles : emoji large = 2 colonnes ; **sélecteur de variante `U+FE0F` = 0**,
   et une base suivie de `U+FE0F` (ex. `↩️`) compte 2 ; box-drawing et `−` (U+2212) = 1. Toute
   nouvelle icône doit être validée par le test d'alignement (toutes les lignes d'un tableau ont la
   même `displayWidth`). Ne pas réintroduire le bloc box-drawing dans `isWide`.

6. **Couleur / liens auto-désactivés hors TTY ou si `NO_COLOR`.** Rend la sortie non-TTY
   déterministe → les tests passent `{color:false, hyperlinks:false}` et asservissent la mise en page.

7. **« Tes PR » est un dashboard**, alimenté par `search author:@me is:open` (pas seulement par les
   notifications), sinon la section est vide quand personne n'a bougé sur tes PR.

8. **Coût.** `collectPRs` fait un `gh pr view` par PR (auteur/date/diff/CI) → `gh notif` prend
   quelques secondes. Concurrence limitée à 8 (`mapLimit`) pour ne pas spawner des dizaines de
   process `gh`. Le scope (`--org`/`--repo`) filtre **avant** ces appels.

9. **Apostrophes typographiques (`U+2019`).** Les libellés FR (`t'a répondu`, `t'a mentionné`)
   utilisent `'` (U+2019), pas l'ASCII `'`. Régression récurrente : vérifier les octets si tu touches
   ces chaînes. Les tests asservissent ça.

## Conventions de test

- Logique pure (`filter`, `render` helpers, `state`, `collect`, `ciRollup`, `scope`) : fixtures, pas
  de réseau. `github.js` testé via un `runner` stub qui capture les args passés à `gh`.
- Entrypoint (`gh-notif`) : pas de tests unitaires (I/O + boucle) → vérifié par smoke test manuel.
- Avant de conclure : `npm test` vert **et** `for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`.
- Pour vérifier l'alignement réel : rendre la sortie, dépouiller ANSI/OSC, et confirmer que toutes
  les lignes d'un même tableau ont la même `displayWidth`.
