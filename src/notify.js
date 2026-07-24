import { spawn as nodeSpawn } from 'node:child_process';
import { CATEGORY } from './filter.js';
import { isReady } from './approvals.js';
import { hyperlink } from './render.js';

export function notifyMessage(item) {
  let title;
  switch (item.category) {
    case CATEGORY.REVIEW_REQUEST: title = 'New PR to review'; break;
    case CATEGORY.MENTION:        title = item.actor ? `@${item.actor} mentioned you` : 'You were mentioned'; break;
    case CATEGORY.ON_MY_PR:       title = item.actor ? `@${item.actor} commented on your PR` : 'New activity on your PR'; break;
    case CATEGORY.THREAD_REPLY:   title = item.actor ? `@${item.actor} replied to you` : 'New reply to your comment'; break;
    case CATEGORY.APPROVAL:       title = `${item.actor ? `@${item.actor}` : 'Someone'} approved your PR${isReady(item.count) ? ' 🎉 ready to merge' : ''}`; break;
    default:                      title = 'Notification';
  }
  const body = `${item.repo} #${item.number} — ${item.title}\n${item.url}`;
  return { title, body };
}

// System command to launch for a desktop notification, depending on the platform
// (pure, testable). macOS has no `notify-send`: we go through `osascript` (shipped
// by default, zero dependency). ⚠️ An AppleScript source cannot contain a line
// break inside a literal, and you must escape `\` then `"` — otherwise a PR title
// with quotes breaks the command.
export function notifyCommand(platform, { title, body }) {
  if (platform === 'darwin') {
    const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
    return { cmd: 'osascript', args: ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`] };
  }
  // Linux (and default): notify-send.
  return { cmd: 'notify-send', args: [title, body] };
}

export function sendNotification(item, spawn = nodeSpawn, platform = process.platform) {
  const { cmd, args } = notifyCommand(platform, notifyMessage(item));
  const child = spawn(cmd, [...args], { stdio: 'ignore' });
  // Best-effort: if the command is missing (ENOENT), we swallow the error instead
  // of letting an unhandled 'error' event kill the --watch/--serve loop.
  if (child.on) child.on('error', () => {});
  if (child.unref) child.unref();
}

// Terminal line for a notification pushed by `--watch`: timestamp + reason
// (the trigger) + clickable repo/PR/title (OSC 8). `title` is exactly the reason
// shown in the desktop notification. `opts.hyperlinks` (default true) controls the
// link — pass false outside a TTY.
export function watchEventLine(item, time, opts = {}) {
  const { title } = notifyMessage(item);
  const target = hyperlink(item.url, `${item.repo} #${item.number} ${item.title}`, {
    hyperlinks: opts.hyperlinks ?? true,
  });
  return `🔔 ${time}  ${title}  ·  ${target}`;
}
