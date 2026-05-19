const CSV_COLUMNS = [
  'video_id',
  'post_date',
  'post_time',
  'caption',
  'duration_ms',
  'views',
  'likes',
  'comments',
  'shares',
  'ECR',
  'avg_watch_time_s',
  'NAWP',
  'watched_full_pct',
  'traffic_foryou_pct',
  'traffic_follow_pct',
  'traffic_profile_pct',
  'traffic_search_pct',
  'new_followers',
  'creator_uid',
  'creator_handle',
  'follower_count',
  'account_created_date',
  'data_quality'
];

const els = {
  tabs: document.querySelectorAll('.tab'),
  panels: document.querySelectorAll('.tab-panel'),
  pageWarning: document.getElementById('page-warning'),
  openStudio: document.getElementById('open-studio'),

  startDate: document.getElementById('start-date'),
  endDate: document.getElementById('end-date'),
  presets: document.querySelectorAll('.presets button'),
  start: document.getElementById('start'),
  cancel: document.getElementById('cancel'),
  reset: document.getElementById('reset'),
  phaseLabel: document.getElementById('phase-label'),
  barFill: document.getElementById('bar-fill'),
  progressText: document.getElementById('progress-text'),
  countVideos: document.getElementById('count-videos'),
  countRows: document.getElementById('count-rows'),
  countSkipped: document.getElementById('count-skipped'),
  error: document.getElementById('error'),
  downloadSection: document.getElementById('download-section'),
  download: document.getElementById('download'),
  skippedList: document.getElementById('skipped-list'),

  singleInput: document.getElementById('single-input'),
  singleFetch: document.getElementById('single-fetch'),
  singleCopy: document.getElementById('single-copy'),
  singleCopyRaw: document.getElementById('single-copy-raw'),
  singleStatus: document.getElementById('single-status'),
  singlePhase: document.getElementById('single-phase'),
  singleMeta: document.getElementById('single-meta'),
  singleError: document.getElementById('single-error'),
  singleResult: document.getElementById('single-result'),
  singleRowTable: document.getElementById('single-row-table'),
  singleRaw: document.getElementById('single-raw'),

  dbgVl: document.getElementById('dbg-vl'),
  dbgIns: document.getElementById('dbg-ins'),
  dbgProf: document.getElementById('dbg-prof'),
  dbgFilter: document.getElementById('dbg-filter'),
  dbgCopy: document.getElementById('dbg-copy'),
  dbgClear: document.getElementById('dbg-clear'),
  dbgList: document.getElementById('dbg-urls'),
  dbgSampleWrap: document.getElementById('dbg-sample-wrap'),
  dbgSample: document.getElementById('dbg-sample')
};

let activeTabId = null;
let pollHandle = null;
let lastSingleResult = null;

init().catch((err) => showError(String(err?.message || err)));

async function init() {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  await checkPageContext(tab);
  setDefaultDates();
  attachListeners();
  refreshState();
  pollHandle = setInterval(refreshState, 500);
  window.addEventListener('unload', () => clearInterval(pollHandle));
}

function setDefaultDates() {
  const today = new Date();
  const thirty = new Date();
  thirty.setDate(today.getDate() - 30);
  els.endDate.value = isoDate(today);
  els.startDate.value = isoDate(thirty);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function attachListeners() {
  els.tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  els.openStudio.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.tiktok.com/tiktokstudio/content' });
  });

  els.presets.forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = btn.dataset.days;
      const today = new Date();
      els.endDate.value = isoDate(today);
      if (!days) {
        els.startDate.value = '';
      } else {
        const start = new Date();
        start.setDate(today.getDate() - Number(days));
        els.startDate.value = isoDate(start);
      }
    });
  });

  els.start.addEventListener('click', startExport);
  els.cancel.addEventListener('click', cancelExport);
  els.reset.addEventListener('click', resetExport);
  els.download.addEventListener('click', downloadCSV);

  els.singleFetch.addEventListener('click', runSingleFetch);
  els.singleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSingleFetch();
  });
  els.singleCopy.addEventListener('click', () => {
    if (lastSingleResult?.row) copyText(JSON.stringify(lastSingleResult.row, null, 2));
  });
  els.singleCopyRaw.addEventListener('click', () => {
    if (lastSingleResult?.raw) copyText(JSON.stringify(lastSingleResult.raw, null, 2));
  });

  els.dbgFilter.addEventListener('input', () => refreshState());
  els.dbgCopy.addEventListener('click', copyDebugURLs);
  els.dbgClear.addEventListener('click', async () => {
    await sendBg({ type: 'reset-state' });
    refreshState();
  });
}

function switchTab(name) {
  els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  els.panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
}

async function startExport() {
  hideError();
  if (!activeTabId) {
    showError('No active TikTok tab. Open TikTok Studio first.');
    return;
  }
  const dateRange = {
    start: els.startDate.value || null,
    end: els.endDate.value || null
  };
  const res = await sendBg({ type: 'start-export', dateRange, tabId: activeTabId });
  if (!res?.ok) showError(res?.error || 'Failed to start export');
  refreshState();
}

async function cancelExport() {
  await sendBg({ type: 'cancel-export' });
  refreshState();
}

async function resetExport() {
  await sendBg({ type: 'reset-state' });
  refreshState();
}

async function refreshState() {
  const res = await sendBg({ type: 'get-state' }).catch(() => null);
  const state = res?.state;
  if (!state) return;
  renderBulk(state);
  renderDebug(state);
}

function renderBulk(state) {
  els.phaseLabel.textContent = state.phase;
  const total = state.progress?.total ?? 0;
  const current = state.progress?.current ?? 0;
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : phaseToPct(state.phase);
  els.barFill.style.width = `${pct}%`;
  els.progressText.textContent = state.progress?.message || (total ? `${current}/${total}` : '—');
  els.countVideos.textContent = String(Object.keys(state.videos || {}).length);
  els.countRows.textContent = String((state.rows || []).length);
  els.countSkipped.textContent = String((state.skipped || []).length);

  if (state.error) showError(state.error);
  else hideError();

  const running = state.phase === 'collecting-list' || state.phase === 'fetching-insights' || state.phase === 'fetching-profile';
  els.start.disabled = running;
  els.cancel.classList.toggle('hidden', !running);

  const showDownload = state.phase === 'done' && (state.rows || []).length > 0;
  els.downloadSection.classList.toggle('hidden', !showDownload);
  if (showDownload) renderSkipped(state.skipped || []);
}

function renderSkipped(skipped) {
  els.skippedList.innerHTML = '';
  for (const s of skipped) {
    const li = document.createElement('li');
    li.textContent = `${s.aweme_id} — ${s.reason}`;
    els.skippedList.appendChild(li);
  }
}

function renderDebug(state) {
  const counts = state.interceptCounts || {};
  els.dbgVl.textContent = String(counts.videoList ?? 0);
  els.dbgIns.textContent = String(counts.insight ?? 0);
  els.dbgProf.textContent = String(counts.profile ?? 0);

  const filter = els.dbgFilter.value.trim().toLowerCase();
  const urls = (state.recentURLs || []).slice().reverse();
  els.dbgList.innerHTML = '';
  for (const entry of urls) {
    if (filter && !entry.url.toLowerCase().includes(filter)) continue;
    const li = document.createElement('li');
    const isList = /item_list|aweme\/post|post\/list/i.test(entry.url);
    if (isList) li.classList.add('match-list');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${entry.method || 'GET'} ×${entry.count || 1}`;
    li.appendChild(badge);
    li.appendChild(document.createTextNode(entry.url));
    els.dbgList.appendChild(li);
  }

  if (state.lastVideoListSample) {
    els.dbgSampleWrap.classList.remove('hidden');
    els.dbgSample.textContent = JSON.stringify(state.lastVideoListSample, null, 2);
  } else {
    els.dbgSampleWrap.classList.add('hidden');
    els.dbgSample.textContent = '';
  }
}

function phaseToPct(phase) {
  switch (phase) {
    case 'collecting-list': return 10;
    case 'fetching-profile': return 95;
    case 'done': return 100;
    case 'cancelled':
    case 'error': return 0;
    default: return 0;
  }
}

async function downloadCSV() {
  const res = await sendBg({ type: 'get-state' });
  const state = res?.state;
  if (!state || !state.rows?.length) return;
  const csv = buildCSV(state.rows);
  const handle = state.profile?.creator_handle || 'unknown';
  const today = isoDate(new Date());
  const filename = `tiktok_analytics_${sanitize(handle)}_${today}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function buildCSV(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => escapeCSV(row[c])).join(','));
  }
  return lines.join('\n');
}

function escapeCSV(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sanitize(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
}

async function runSingleFetch() {
  hideSingleError();
  els.singleResult.classList.add('hidden');
  lastSingleResult = null;
  els.singleCopy.disabled = true;
  els.singleCopyRaw.disabled = true;

  const raw = els.singleInput.value.trim();
  if (!raw) {
    showSingleError('Paste a video ID or video URL first.');
    return;
  }
  if (!activeTabId) {
    showSingleError('No active TikTok tab. Open TikTok Studio first.');
    return;
  }

  els.singleStatus.classList.remove('hidden');
  els.singlePhase.textContent = 'fetching…';
  els.singleMeta.textContent = '';
  els.singleFetch.disabled = true;

  try {
    const res = await sendBg({
      type: 'single-video-fetch',
      tabId: activeTabId,
      awemeId: raw
    });
    if (!res?.ok) {
      showSingleError(res?.error || 'fetch failed');
      els.singlePhase.textContent = 'error';
      els.singleMeta.textContent = res?.url ? ` ${res.url}` : '';
      return;
    }
    lastSingleResult = res;
    els.singlePhase.textContent = res.parseError ? 'parsed with warnings' : 'done';
    els.singleMeta.textContent = ` ${res.elapsed}ms · status ${res.status} · id ${res.awemeId}`;
    renderSingleRow(res);
    els.singleResult.classList.remove('hidden');
    els.singleCopy.disabled = !res.row;
    els.singleCopyRaw.disabled = !res.raw;
    if (res.parseError) showSingleError(`Parse warning: ${res.parseError}`);
  } catch (err) {
    showSingleError(String(err?.message || err));
    els.singlePhase.textContent = 'error';
  } finally {
    els.singleFetch.disabled = false;
  }
}

function renderSingleRow(result) {
  els.singleRowTable.innerHTML = '';
  const row = result.row || {};
  const columns = result.row ? CSV_COLUMNS : [];
  if (columns.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = '(no parsed row — check raw response below)';
    tr.appendChild(td);
    els.singleRowTable.appendChild(tr);
  } else {
    for (const col of columns) {
      const tr = document.createElement('tr');
      const k = document.createElement('td');
      k.textContent = col;
      const v = document.createElement('td');
      const value = row[col];
      v.textContent = value === '' || value == null ? '—' : String(value);
      tr.appendChild(k);
      tr.appendChild(v);
      els.singleRowTable.appendChild(tr);
    }
  }
  els.singleRaw.textContent = result.raw ? JSON.stringify(result.raw, null, 2) : '';
}

function copyDebugURLs() {
  const urls = Array.from(els.dbgList.querySelectorAll('li'))
    .map((li) => li.textContent.trim())
    .join('\n');
  copyText(urls);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove('hidden');
}
function hideError() {
  els.error.textContent = '';
  els.error.classList.add('hidden');
}
function showSingleError(msg) {
  els.singleError.textContent = msg;
  els.singleError.classList.remove('hidden');
}
function hideSingleError() {
  els.singleError.textContent = '';
  els.singleError.classList.add('hidden');
}

async function checkPageContext(tab) {
  if (!tab?.url || !/tiktok\.com/i.test(tab.url)) {
    els.pageWarning.classList.remove('hidden');
    return;
  }
  if (!/(creator-center|tiktokstudio)\/content/i.test(tab.url)) {
    els.pageWarning.classList.remove('hidden');
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const _err = chrome.runtime.lastError;
      resolve(response);
    });
  });
}
