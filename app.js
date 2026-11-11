/* Cryptic Library — a browsable index of every Cracking the Cryptic sudoku.
   Static, dependency-free ES module. Data comes from data/puzzles.json,
   which .github/workflows/scrape.yml refreshes daily. */

const DATA_URL = 'data/puzzles.json';
const RULES_URL = 'data/rules.json';
const CHUNK = 80;
const CTC = 'https://crackingthecryptic.com';

/* ── storage ─────────────────────────────────────────────── */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('ctc.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('ctc.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const favs = new Set(store.get('fav', []));
const solved = new Set(store.get('solved', []));
const played = new Set(store.get('played', []));

/* ── state ───────────────────────────────────────────────── */
const state = {
  items: [],
  generated: null,
  newIds: new Set(),
  q: '',
  tags: new Set(store.get('f.tags', [])),
  author: store.get('f.author', ''),
  status: store.get('f.status', 'all'),
  sort: store.get('f.sort', 'newest'),
  view: [],          // filtered
  shown: 0,
  scrollY: 0,
  current: null,     // open puzzle
  rules: null,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  list: $('#list'), count: $('#countLine'), sync: $('#syncLine'),
  q: $('#q'), clearQ: $('#clearQ'), chips: $('#tagChips'),
  author: $('#authorSel'), status: $('#statusSel'), sort: $('#sortSel'),
  reset: $('#resetBtn'), reset2: $('#resetBtn2'), empty: $('#empty'),
  sentinel: $('#sentinel'), wrap: $('.list-wrap'),
  player: $('#player'), pad: $('#pad'), stageNote: $('#stageNote'),
  pName: $('#pName'), pMeta: $('#pMeta'), favBtn: $('#favBtn'), doneBtn: $('#doneBtn'),
  rulesBtn: $('#rulesBtn'), rulesSheet: $('#rulesSheet'), rulesBody: $('#rulesBody'),
  padLink: $('#padLink'), videoLink: $('#videoLink'), ctcLink: $('#ctcLink'),
  toast: $('#toast'), dataStamp: $('#dataStamp'),
};

/* ── helpers ─────────────────────────────────────────────── */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => n.toLocaleString('en-US');
const fmtDate = (d) => {
  if (!d) return '';
  const t = Date.parse(d + 'T12:00:00Z');
  if (Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900);
}

/* ── load ────────────────────────────────────────────────── */
async function load() {
  let blob;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    blob = await res.json();
  } catch (err) {
    el.count.innerHTML = 'Could not load the puzzle index.';
    el.sync.textContent = /offline/i.test(String(err)) ? 'You are offline — cached data unavailable.' : 'Retry when you have a connection.';
    return;
  }

  const items = (blob.items || []).map((r) => ({
    id: r[0],
    date: r[1] || '',
    name: r[2] || 'Untitled',
    author: r[3] || '',
    variant: r[4] || '',
    solver: r[5] || '',
    pad: r[6] || '',
    tags: (r[7] || '').split(' ').filter(Boolean),
    search: [r[2], r[3], r[4], (r[7] || '')].join(' ').toLowerCase(),
  }));

  state.items = items;
  state.generated = blob.generated || null;

  // "New" = published after the newest puzzle the user had already seen.
  const latest = blob.latest || '';
  const seenBefore = store.get('lastSeen', null);
  if (seenBefore) {
    for (const it of items) if (it.date > seenBefore) state.newIds.add(it.id);
    const n = state.newIds.size;
    if (n) setTimeout(() => toast(`${n} new puzzle${n > 1 ? 's' : ''} since your last visit`), 700);
  }
  store.set('lastSeen', latest || new Date().toISOString().slice(0, 10));

  el.dataStamp.textContent = `Index built ${state.generated ? new Date(state.generated).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'} · ${num(items.length)} puzzles`;
  buildChips();
  buildAuthors();
  apply();
  routeFromHash();
}

/* ── filters UI ──────────────────────────────────────────── */
function tagCounts(excludeTags = false) {
  const counts = new Map();
  for (const it of state.items) {
    if (!passes(it, { ignoreTags: excludeTags, ignoreStatus: false })) continue;
    for (const t of it.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function passes(it, { ignoreTags = false, ignoreStatus = false } = {}) {
  if (state.q) {
    for (const token of state.q.split(/\s+/)) if (token && !it.search.includes(token)) return false;
  }
  if (state.author && it.author !== state.author) return false;
  if (!ignoreTags) for (const t of state.tags) if (!it.tags.includes(t)) return false;
  if (!ignoreStatus) {
    switch (state.status) {
      case 'new': if (!state.newIds.has(it.id)) return false; break;
      case 'solved': if (!solved.has(it.id)) return false; break;
      case 'fav': if (!favs.has(it.id)) return false; break;
      case 'playing': if (!played.has(it.id) || solved.has(it.id)) return false; break;
      case 'unplayed': if (played.has(it.id) || solved.has(it.id)) return false; break;
      default: break;
    }
  }
  return true;
}

function buildChips() {
  const counts = tagCounts(true).slice(0, 18);
  el.chips.innerHTML = counts.map(([tag, n]) =>
    `<button class="chip${state.tags.has(tag) ? ' on' : ''}" data-tag="${esc(tag)}" aria-pressed="${state.tags.has(tag)}">${esc(tag)} <b>${n > 999 ? (n / 1000).toFixed(1) + 'k' : n}</b></button>`
  ).join('');

  el.chips.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (state.tags.has(tag)) state.tags.delete(tag); else state.tags.add(tag);
      store.set('f.tags', [...state.tags]);
      buildChips();
      apply();
    });
  });
}

function buildAuthors() {
  const counts = new Map();
  for (const it of state.items) if (it.author) counts.set(it.author, (counts.get(it.author) || 0) + 1);
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  el.author.innerHTML = '<option value="">Anyone</option>' + list.map(([a, n]) =>
    `<option value="${esc(a)}"${a === state.author ? ' selected' : ''}>${esc(a)} (${n})</option>`
  ).join('');
  el.author.value = state.author;
}

function syncFilterControls() {
  const dirty = state.tags.size > 0 || state.author || state.status !== 'all' || state.q;
  el.reset.hidden = !dirty;
  el.status.value = state.status;
  el.sort.value = state.sort;
  el.author.value = state.author;
  el.clearQ.hidden = !state.q;
  el.q.value = state.q;
}

/* ── render ──────────────────────────────────────────────── */
function apply() {
  state.view = state.items.filter((it) => passes(it));
  switch (state.sort) {
    case 'oldest': state.view.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1); break;
    case 'name': state.view.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'setter': state.view.sort((a, b) => (a.author || 'zzz').localeCompare(b.author || 'zzz') || a.name.localeCompare(b.name)); break;
    default: break; // newest = data order (index is newest-first)
  }

  state.shown = 0;
  el.list.innerHTML = '';
  el.empty.hidden = state.view.length !== 0;
  el.count.innerHTML = state.view.length === state.items.length
    ? `<b>${num(state.view.length)}</b> puzzles${state.newIds.size ? ` · <b>${state.newIds.size}</b> new` : ''}`
    : `<b>${num(state.view.length)}</b> of ${num(state.items.length)}`;
  syncFilterControls();
  renderChunk();
  el.wrap.scrollTop = 0;
}

function rowHTML(it) {
  const isNew = state.newIds.has(it.id);
  const isSolved = solved.has(it.id);
  const isFav = favs.has(it.id);
  const isPlaying = played.has(it.id) && !isSolved;

  let icon = '';
  if (isSolved) icon = `<span class="state-ico solved" title="Solved"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></span>`;
  else if (isFav) icon = `<span class="state-ico fav" title="Favourite"><svg viewBox="0 0 24 24"><path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.9-5.2 2.9 1-5.9L3.5 9.8l5.9-.8z"/></svg></span>`;
  else if (isPlaying) icon = `<span class="state-ico playing" title="In progress">•</span>`;

  const solver = it.solver === 'S'
    ? `<span class="solver S" title="Solved by Simon">S</span>`
    : it.solver === 'M'
      ? `<span class="solver M" title="Solved by Mark">M</span>`
      : '';

  return `<li class="row" data-id="${it.id}">
    <div class="row-main">
      <div class="row-name">${isNew ? '<span class="flag-dot" title="New"></span>' : ''}${esc(it.name)}</div>
      <div class="row-sub">${solver}<span class="setter">${esc(it.author || 'Unknown setter')}</span><span class="sep">·</span><span>${fmtDate(it.date)}</span></div>
    </div>
    <div class="row-right">${it.variant ? `<span class="vtag">${esc(it.variant)}</span>` : ''}${icon}</div>
  </li>`;
}

function renderChunk() {
  if (state.shown >= state.view.length) return;
  const slice = state.view.slice(state.shown, state.shown + CHUNK);
  state.shown += slice.length;
  el.list.insertAdjacentHTML('beforeend', slice.map(rowHTML).join(''));
}

const observer = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) renderChunk();
}, { rootMargin: '1200px' });
observer.observe(el.sentinel);

el.list.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) openPuzzle(Number(row.dataset.id));
});

/* ── player ──────────────────────────────────────────────── */
function findItem(id) { return state.items.find((i) => i.id === id); }

async function openPuzzle(id, { push = true } = {}) {
  const it = findItem(id);
  if (!it) { toast('Puzzle not found in the index'); return; }

  state.current = it;
  state.scrollY = el.wrap.scrollTop;
  el.pName.textContent = it.name;
  el.pMeta.textContent = [it.author || 'Unknown setter', it.variant, fmtDate(it.date)].filter(Boolean).join('  ·  ');
  el.favBtn.classList.toggle('on', favs.has(id));
  el.doneBtn.classList.toggle('on', solved.has(id));
  el.doneBtn.title = solved.has(id) ? 'Solved — tap to undo' : 'Mark solved';

  el.padLink.href = it.pad ? `https://sudokupad.app/${it.pad}` : `${CTC}/sudoku?id=${it.id}`;
  el.padLink.textContent = it.pad ? 'SudokuPad ↗' : 'CTC page ↗';
  el.videoLink.hidden = !it.solver;
  el.videoLink.href = `${CTC}/sudokuwatch?id=${it.id}`;
  el.ctcLink.href = `${CTC}/sudoku?id=${it.id}`;

  if (it.pad) {
    el.pad.hidden = false;
    el.stageNote.hidden = true;
    el.pad.src = `https://sudokupad.app/${it.pad}`;
  } else {
    el.pad.hidden = true;
    el.pad.src = 'about:blank';
    el.stageNote.hidden = false;
    el.stageNote.innerHTML = '<b>No SudokuPad version for this one.</b>It predates the player — use “CTC page ↗” below.';
  }

  el.rulesBody.textContent = 'Loading rules…';
  loadRules(id);

  played.add(id);
  store.set('played', [...played]);

  el.player.hidden = false;
  document.body.style.overflow = 'hidden';

  if (push && location.hash !== `#/p/${id}`) history.pushState({ id }, '', `#/p/${id}`);
}

function closePuzzle({ fromHistory = false } = {}) {
  if (!state.current) return;
  state.current = null;
  el.player.hidden = true;
  el.pad.src = 'about:blank';
  el.rulesSheet.hidden = true;
  document.body.style.overflow = '';
  el.wrap.scrollTop = state.scrollY;
  if (!fromHistory && location.hash.startsWith('#/p/')) history.replaceState(null, '', location.pathname + location.search);
  refreshRow();
}

function refreshRow() {
  // Cheap targeted refresh: re-render just the visible rows for this puzzle.
  for (const li of el.list.querySelectorAll('.row')) {
    const id = Number(li.dataset.id);
    if (![Number(state.current?.id)].includes(id)) continue;
    const it = findItem(id);
    if (it) li.outerHTML = rowHTML(it);
  }
}

async function loadRules(id) {
  try {
    if (!state.rulesCache) {
      const res = await fetch(RULES_URL, { cache: 'force-cache' });
      state.rulesCache = res.ok ? await res.json() : {};
    }
    const text = state.rulesCache[String(id)];
    if (state.current?.id !== id) return;
    el.rulesBody.textContent = text || 'No rules text was published for this puzzle. It may be a classic sudoku, or the rules live only in the video.';
  } catch {
    if (state.current?.id === id) el.rulesBody.textContent = 'Rules unavailable offline.';
  }
}

/* ── player controls ─────────────────────────────────────── */
$('#backBtn').addEventListener('click', () => history.length > 1 ? history.back() : closePuzzle());

el.favBtn.addEventListener('click', () => {
  const id = state.current?.id; if (!id) return;
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  store.set('fav', [...favs]);
  el.favBtn.classList.toggle('on', favs.has(id));
  toast(favs.has(id) ? 'Added to favourites' : 'Removed from favourites');
});

el.doneBtn.addEventListener('click', () => {
  const id = state.current?.id; if (!id) return;
  if (solved.has(id)) solved.delete(id); else solved.add(id);
  store.set('solved', [...solved]);
  el.doneBtn.classList.toggle('on', solved.has(id));
  toast(solved.has(id) ? 'Marked as solved' : 'Marked unsolved');
});

el.rulesBtn.addEventListener('click', () => { el.rulesSheet.hidden = false; });
$('#rulesClose').addEventListener('click', () => { el.rulesSheet.hidden = true; });
el.rulesSheet.addEventListener('click', (e) => { if (e.target === el.rulesSheet) el.rulesSheet.hidden = true; });

$('#shareBtn').addEventListener('click', async () => {
  const it = state.current; if (!it) return;
  const url = `${location.origin}${location.pathname}#/p/${it.id}`;
  const data = { title: `${it.name} — Cryptic Library`, text: `${it.name}${it.author ? ` by ${it.author}` : ''}`, url };
  if (navigator.share) { try { await navigator.share(data); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
});

/* ── routing ─────────────────────────────────────────────── */
function routeFromHash() {
  const hash = location.hash;
  const m = hash.match(/^#\/p\/(\d+)$/);
  if (m) { openPuzzle(Number(m[1]), { push: false }); return; }

  if (hash === '#random') {
    history.replaceState(null, '', location.pathname);
    const pool = state.items.filter((it) => !solved.has(it.id));
    const pick = (pool.length ? pool : state.items)[Math.floor(Math.random() * (pool.length || state.items.length))];
    if (pick) openPuzzle(pick.id);
    return;
  }
  if (hash === '#fav') {
    state.status = 'fav';
    store.set('f.status', 'fav');
    history.replaceState(null, '', location.pathname);
    apply();
    return;
  }
  closePuzzle({ fromHistory: true });
}

window.addEventListener('hashchange', routeFromHash);
window.addEventListener('popstate', () => {
  const m = location.hash.match(/^#\/p\/(\d+)$/);
  if (m) openPuzzle(Number(m[1]), { push: false });
  else closePuzzle({ fromHistory: true });
});

/* ── controls ────────────────────────────────────────────── */
let searchTimer;
el.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = el.q.value.trim().toLowerCase();
    apply();
  }, 110);
});

el.clearQ.addEventListener('click', () => { el.q.value = ''; state.q = ''; apply(); el.q.focus(); });

el.status.addEventListener('change', () => { state.status = el.status.value; store.set('f.status', state.status); apply(); });
el.sort.addEventListener('change', () => { state.sort = el.sort.value; store.set('f.sort', state.sort); apply(); });
el.author.addEventListener('change', () => { state.author = el.author.value; store.set('f.author', state.author); apply(); });

function resetFilters() {
  state.q = ''; state.tags.clear(); state.author = ''; state.status = 'all';
  store.set('f.tags', []); store.set('f.author', ''); store.set('f.status', 'all');
  buildChips(); apply();
}
el.reset.addEventListener('click', resetFilters);
el.reset2.addEventListener('click', resetFilters);

$('#randomBtn').addEventListener('click', () => {
  const pool = (state.view.length ? state.view : state.items).filter((it) => !solved.has(it.id));
  const pick = (pool.length ? pool : state.items)[Math.floor(Math.random() * (pool.length || state.items.length))];
  if (pick) openPuzzle(pick.id);
});

const themeBtn = $('#themeBtn');
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  document.querySelector('meta[name=theme-color]').setAttribute('content', t === 'light' ? '#f6f7fb' : '#0d0f14');
}
themeBtn.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});
setTheme(store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

$('#brand').addEventListener('click', () => {
  if (state.current) history.length > 1 ? history.back() : closePuzzle();
  el.wrap.scrollTo({ top: 0, behavior: 'smooth' });
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape') { e.target.blur(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const open = !el.player.hidden;
  if (e.key === '/') { e.preventDefault(); el.q.focus(); el.q.select(); }
  else if (e.key === 'Escape') { if (!el.rulesSheet.hidden) el.rulesSheet.hidden = true; else if (open) history.back(); }
  else if (e.key === 'r') { if (!el.rulesSheet.hidden) return; $('#randomBtn').click(); }
  else if (e.key === 'f' && open) { el.favBtn.click(); }
  else if (e.key === 's' && open) { el.doneBtn.click(); }
});

/* ── service worker / install ────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* http:// or blocked */ });
  });
}

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  if (document.getElementById('installPill')) return;
  const pill = document.createElement('button');
  pill.id = 'installPill';
  pill.className = 'pill ghost';
  pill.textContent = 'Install app';
  pill.addEventListener('click', async () => {
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    pill.remove();
  });
  document.querySelector('.selects').appendChild(pill);
});

window.addEventListener('appinstalled', () => {
  document.getElementById('installPill')?.remove();
  toast('Installed — find it on your home screen');
});

/* ── go ──────────────────────────────────────────────────── */
syncFilterControls();
load();
