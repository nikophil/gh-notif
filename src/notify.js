import { spawn as nodeSpawn } from 'node:child_process';
import { CATEGORY } from './filter.js';

export function notifyMessage(item) {
  let title;
  switch (item.category) {
    case CATEGORY.REVIEW_REQUEST: title = 'Nouvelle PR à review'; break;
    case CATEGORY.MENTION:        title = `@${item.actor} t'a mentionné`; break;
    case CATEGORY.ON_MY_PR:       title = `@${item.actor} a commenté ta PR`; break;
    case CATEGORY.THREAD_REPLY:   title = `@${item.actor} t'a répondu`; break;
    default:                      title = 'Notification';
  }
  const body = `${item.repo} #${item.number} — ${item.title}\n${item.url}`;
  return { title, body };
}

export function sendNotification(item, spawn = nodeSpawn) {
  const { title, body } = notifyMessage(item);
  const child = spawn('notify-send', [title, body], { stdio: 'ignore' });
  if (child.unref) child.unref();
}
