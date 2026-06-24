# gh-notif

Extension `gh` CLI : notifications GitHub filtrées finement.

Notifie uniquement pour : reviews demandées, mentions, activité d'autrui sur **mes** PR,
et réponses à **mes** commentaires. Ignore les mises à jour de PR (push/CI/merge) et le bruit
des PR où je suis simple reviewer.

## Prérequis
- `gh` authentifié (`gh auth login`)
- Node ≥ 18
- `notify-send` (paquet `libnotify-bin`) pour les notifs desktop

## Installation
```bash
gh extension install .
# ou depuis le repo distant :
# gh extension install nikophil/gh-notif
```

## Usage
```bash
gh notif            # liste filtrée + reviews en attente
gh notif --all      # inclut les notifications déjà lues
gh notif --watch    # surveille et pousse des notifs desktop (toutes les 60s)
```

## Tests
```bash
npm test
```
