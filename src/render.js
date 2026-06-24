import { CATEGORY } from './filter.js';

const SECTIONS = [
  { category: CATEGORY.REVIEW_REQUEST, icon: '🔍', label: 'Reviews demandées' },
  { category: CATEGORY.MENTION,        icon: '💬', label: 'Mentions' },
  { category: CATEGORY.ON_MY_PR,       icon: '📥', label: 'Activité sur tes PR' },
  { category: CATEGORY.THREAD_REPLY,   icon: '↩️', label: 'Réponses à tes commentaires' },
];

function suffix(item) {
  switch (item.category) {
    case CATEGORY.MENTION:      return `  — mention de @${item.actor}`;
    case CATEGORY.ON_MY_PR:     return `  — @${item.actor} a commenté`;
    case CATEGORY.THREAD_REPLY: return `  — @${item.actor} t'a répondu`;
    default:                    return '';
  }
}

function renderItem(item) {
  return `  ${item.repo} #${item.number}  ${item.title}${suffix(item)}\n  → ${item.url}`;
}

export function renderList(items, pending) {
  const blocks = [];
  for (const section of SECTIONS) {
    const group = items.filter((i) => i.category === section.category);
    if (group.length === 0) continue;
    blocks.push(`${section.icon} ${section.label} (${group.length})\n${group.map(renderItem).join('\n')}`);
  }
  if (pending.length > 0) {
    const lines = pending.map((p) => `  ${p.repo} #${p.number}  ${p.title}\n  → ${p.url}`).join('\n');
    blocks.push(`${'─'.repeat(30)}\n📋 Reviews en attente (${pending.length})\n${lines}`);
  }
  if (blocks.length === 0) return 'Rien à signaler ✨\n';
  return blocks.join('\n\n') + '\n';
}
