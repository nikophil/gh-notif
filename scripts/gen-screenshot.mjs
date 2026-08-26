// Regenerates docs/screenshot.png's source page: fake open-source sample data
// rendered with the real renderShell/renderFragment, so the look is exactly
// the app's — without leaking real dashboard content.
//
// Usage:
//   node scripts/gen-screenshot.mjs "$HOME/gh-notif-sample.html"
//   chromium --headless --disable-gpu --screenshot="$HOME/shot.png" \
//     --window-size=1680,742 --force-device-scale-factor=2 --hide-scrollbars \
//     "file://$HOME/gh-notif-sample.html"
//   mv "$HOME/shot.png" docs/screenshot.png
//
// (snap chromium can only write under $HOME, hence the detour.)
// Keep the sample rows in sync with the columns: a new column should be
// visible here (field on the rows) before regenerating.
import { writeFileSync } from 'node:fs';
import { renderShell, renderFragment } from '../src/html.js';

const NOW = new Date('2026-08-26T16:00:00Z').getTime();
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

const mine = [
  {
    repo: 'facebook/react', number: 28901, url: 'https://github.com/x',
    title: 'Add useFormStatus stories', branch: 'feat/form-status-stories', branchRepo: 'facebook/react',
    labels: [{ name: 'React 19', color: '0e8a16' }],
    triggers: ['comment'], ci: 'pass', state: 'open', approvals: 2,
    createdAt: ago(80), readyAt: ago(52), updatedAt: ago(2),
    additions: 240, deletions: 12,
    diffTypes: [{ ext: '.js', additions: 214, deletions: 10 }, { ext: '.md', additions: 26, deletions: 2 }],
  },
  {
    repo: 'nodejs/node', number: 52012, url: 'https://github.com/x',
    title: 'stream: fix backpressure on paused Readable', branch: 'fix/stream-backpressure', branchRepo: 'nodejs/node',
    labels: [{ name: 'stream', color: 'bfd4f2' }],
    triggers: ['reply'], ci: 'pass', state: 'open', approvals: 3,
    createdAt: ago(200), readyAt: ago(120), updatedAt: ago(7),
    additions: 58, deletions: 21,
    diffTypes: [{ ext: '.js', additions: 40, deletions: 18 }, { ext: '.mjs', additions: 18, deletions: 3 }],
  },
  {
    repo: 'vercel/next.js', number: 64210, url: 'https://github.com/x',
    title: 'fix: turbopack HMR edge case with app router', branch: 'fix/turbopack-hmr', branchRepo: 'vercel/next.js',
    labels: [],
    triggers: [], ci: 'pending', state: 'draft', approvals: 0, conflicting: true,
    createdAt: ago(30), updatedAt: ago(20),
    additions: 96, deletions: 33,
    diffTypes: [{ ext: '.ts', additions: 90, deletions: 30 }, { ext: '.json', additions: 6, deletions: 3 }],
  },
];

const others = [
  {
    repo: 'symfony/symfony', number: 54321, url: 'https://github.com/x',
    title: 'Add #[MapRequestPayload] to the argument resolver', author: 'nicolas-grekas',
    branch: 'feature/map-request-payload', branchRepo: 'symfony/symfony',
    labels: [{ name: 'DX', color: '5319e7' }, { name: 'Serializer', color: 'fbca04' }],
    triggers: ['review'], ci: 'pass', state: 'open', approvals: 1,
    createdAt: ago(2), readyAt: ago(2), updatedAt: ago(1),
    additions: 451, deletions: 10,
    diffTypes: [{ ext: '.php', additions: 402, deletions: 8 }, { ext: '.xml', additions: 49, deletions: 2 }],
  },
  {
    repo: 'laravel/framework', number: 50123, url: 'https://github.com/x',
    title: 'Improve Str::password entropy', author: 'taylorotwell',
    branch: 'password-entropy', branchRepo: 'laravel/framework',
    labels: [{ name: 'enhancement', color: 'a2eeef' }],
    triggers: ['reply'], ci: 'pass', state: 'open', approvals: 4,
    createdAt: ago(5), readyAt: ago(5), updatedAt: ago(3),
    additions: 88, deletions: 4,
    diffTypes: [{ ext: '.php', additions: 88, deletions: 4 }],
  },
  {
    repo: 'vuejs/core', number: 10456, url: 'https://github.com/x',
    title: 'perf: reduce reactivity overhead in dev mode', author: 'yyx990803',
    branch: 'perf/reactivity-dev', branchRepo: 'vuejs/core',
    labels: [],
    triggers: ['review', 'mention'], ci: 'fail', state: 'open', approvals: 0, changesRequested: 1,
    createdAt: ago(26), readyAt: ago(26), updatedAt: ago(4),
    additions: 230, deletions: 180,
    diffTypes: [{ ext: '.ts', additions: 230, deletions: 180 }],
  },
  {
    repo: 'rust-lang/rust', number: 121987, url: 'https://github.com/x',
    title: 'stabilize `const_option` feature', author: 'oli-obk',
    branch: 'const-option-stab', branchRepo: 'rust-lang/rust',
    labels: [{ name: 'T-lang', color: 'd4c5f9' }],
    triggers: ['mention'], ci: 'pass', state: 'open', approvals: 2,
    createdAt: ago(50), readyAt: ago(50), updatedAt: ago(22),
    additions: 12, deletions: 3,
    diffTypes: [{ ext: '.rs', additions: 12, deletions: 3 }],
  },
];

const issues = [
  {
    repo: 'vuejs/core', number: 10502, url: 'https://github.com/x',
    title: 'computed not invalidated when a nested ref is replaced', actor: 'posva',
    createdAt: ago(3), updatedAt: ago(3), triggers: ['new'],
  },
];

const counts = {
  total: { mine: 3, others: 4, issues: 1 },
  byFav: {
    'symfony': { mine: 0, others: 1, issues: 0 },
    'laravel': { mine: 0, others: 1, issues: 0 },
    'vuejs': { mine: 0, others: 2, issues: 1 },
  },
};

const q = (s) => `https://github.com/pulls?q=${encodeURIComponent(s)}`;
const fragment = renderFragment({ mine, others, issues }, {
  now: NOW,
  closedUrl: q('is:pr author:@me is:closed'),
  reviewedUrl: q('is:pr reviewed-by:@me -author:@me'),
  sort: { key: 'updated', dir: 'desc' },
  sortMine: { key: 'updated', dir: 'desc' },
  cols: { mine: [], others: [] },
  ignoredChecks: {},
});

let html = renderShell({
  favorites: ['symfony', 'laravel', 'vuejs'],
  activeFav: null,
  counts,
  favModes: { vuejs: 'all' },
  theme: 'light',
});
html = html.replace('<main id="content"></main>', `<main id="content">${fragment}</main>`);
html = html.replace('<span id="stamp">loading…</span>', '<span id="stamp">upd 16:00:00 · next check in 47s</span>');
// Freeze the page: no polling JS (it would wipe the injected content on a failed fetch).
html = html.replace(/<script>[\s\S]*?<\/script>/g, '');

const out = process.argv[2] ?? `${process.env.HOME}/gh-notif-sample.html`;
writeFileSync(out, html);
console.log('written', out);
