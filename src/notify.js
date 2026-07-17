import { spawn as nodeSpawn } from 'node:child_process';
import { CATEGORY } from './filter.js';
import { isReady } from './approvals.js';
import { hyperlink } from './render.js';

export function notifyMessage(item) {
  let title;
  switch (item.category) {
    case CATEGORY.REVIEW_REQUEST: title = 'Nouvelle PR à review'; break;
    case CATEGORY.MENTION:        title = item.actor ? `@${item.actor} t’a mentionné` : 'Tu as été mentionné'; break;
    case CATEGORY.ON_MY_PR:       title = item.actor ? `@${item.actor} a commenté ta PR` : 'Nouvelle activité sur ta PR'; break;
    case CATEGORY.THREAD_REPLY:   title = item.actor ? `@${item.actor} t’a répondu` : 'Nouvelle réponse à ton commentaire'; break;
    case CATEGORY.APPROVAL:       title = `${item.actor ? `@${item.actor}` : 'Quelqu’un'} a approuvé ta PR${isReady(item.count) ? ' 🎉 prête à merger' : ''}`; break;
    default:                      title = 'Notification';
  }
  const body = `${item.repo} #${item.number} — ${item.title}\n${item.url}`;
  return { title, body };
}

// Commande système à lancer pour une notif desktop, selon la plateforme (pur,
// testable). macOS n'a pas `notify-send` : on passe par `osascript` (fourni de
// base, zéro dépendance). ⚠️ Une source AppleScript ne peut pas contenir de saut
// de ligne dans un littéral, et il faut échapper `\` puis `"` — sinon un titre de
// PR avec des guillemets casse la commande.
export function notifyCommand(platform, { title, body }) {
  if (platform === 'darwin') {
    const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
    return { cmd: 'osascript', args: ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`] };
  }
  // Linux (et défaut) : notify-send.
  return { cmd: 'notify-send', args: [title, body] };
}

export function sendNotification(item, spawn = nodeSpawn, platform = process.platform) {
  const { cmd, args } = notifyCommand(platform, notifyMessage(item));
  const child = spawn(cmd, [...args], { stdio: 'ignore' });
  // Best-effort : si la commande manque (ENOENT), on avale l'erreur au lieu de
  // laisser un évènement 'error' non-géré tuer la boucle --watch/--serve.
  if (child.on) child.on('error', () => {});
  if (child.unref) child.unref();
}

// Ligne terminal pour une notif poussée par `--watch` : horodatage + motif
// (le déclencheur) + dépôt/PR/titre cliquable (OSC 8). `title` est exactement
// le motif affiché dans la notif desktop. `opts.hyperlinks` (défaut true)
// contrôle le lien — passer false hors TTY.
export function watchEventLine(item, time, opts = {}) {
  const { title } = notifyMessage(item);
  const target = hyperlink(item.url, `${item.repo} #${item.number} ${item.title}`, {
    hyperlinks: opts.hyperlinks ?? true,
  });
  return `🔔 ${time}  ${title}  ·  ${target}`;
}
