const VIDEO_LIST_RES = [
  /\/tiktok\/creator\/manage\/item_list\//i,
  /\/aweme\/v\d+\/web\/aweme\/post\//i,
  /\/api\/post\/item_list\//i,
  /\/aweme\/post\/?(?:\?|$)/i
];
const INSIGHT_RE = /\/aweme\/v\d+\/data\/insight\//i;
const PROFILE_RE = /\/aweme\/v\d+\/user\/profile\/self\//i;
const ACCOUNT_INFO_RE = /\/passport\/web\/account_info\//i;
const MAX_RECENT_URLS = 120;

const isVideoListURL = (url) => VIDEO_LIST_RES.some((re) => re.test(url));

const INSIGH_TYPES = [
  'video_retention_rate_realtime',
  'video_per_duration_realtime',
  'video_finish_rate_realtime',
  'video_traffic_source_percent_realtime',
  'video_new_followers',
  'realtime_total_video_views'
];

const DEFAULT_INSIGHT_BASE =
  'https://www.tiktok.com/aweme/v2/data/insight/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web_pc&locale=en&region=PH&channel=tiktok_web&os=mac';

const DEFAULT_PROFILE_URL =
  'https://www.tiktok.com/aweme/v1/user/profile/self/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web_pc&locale=en&channel=tiktok_web';

const PER_INSIGHT_DELAY_MS = 2000;
const PER_INSIGHT_JITTER_MS = 500;
const MAX_VIDEOS = 2000;
const INSIGHT_RETRY_DELAY_MS = 3000;

function defaultState() {
  return {
    phase: 'idle',
    dateRange: null,
    activeTabId: null,
    videos: {},
    insightTemplate: null,
    profileTemplate: null,
    profile: null,
    rows: [],
    skipped: [],
    progress: { current: 0, total: 0, message: '' },
    startedAt: null,
    finishedAt: null,
    error: null,
    recentURLs: [],
    interceptCounts: { videoList: 0, insight: 0, profile: 0 },
    lastVideoListSample: null
  };
}

async function getState() {
  const { exporterState } = await chrome.storage.session.get('exporterState');
  return exporterState ?? defaultState();
}

async function setState(state) {
  await chrome.storage.session.set({ exporterState: state });
}

let _stateQueue = Promise.resolve();

function mutateState(mutator) {
  const next = _stateQueue.then(async () => {
    const state = await getState();
    await mutator(state);
    await setState(state);
    return state;
  });
  _stateQueue = next.catch(() => {});
  return next;
}

async function resetState() {
  await setState(defaultState());
}

chrome.runtime.onInstalled.addListener(async () => {
  const { exporterState } = await chrome.storage.session.get('exporterState');
  if (!exporterState) await resetState();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String(err?.stack || err) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case 'intercepted-response':
      await ingestIntercept(msg);
      return { ok: true };
    case 'url-seen':
      await recordURL(msg.url, msg.method);
      return { ok: true };
    case 'get-state':
      return { ok: true, state: await getState() };
    case 'reset-state':
      await resetState();
      return { ok: true };
    case 'start-export':
      return startExport(msg.dateRange, msg.tabId);
    case 'cancel-export':
      await mutateState((s) => {
        s.phase = 'cancelled';
        s.progress.message = 'Cancelled by user';
      });
      return { ok: true };
    case 'single-video-fetch':
      return singleVideoFetch(msg.tabId, msg.awemeId);
    default:
      return { ok: false, error: `Unknown message: ${msg?.type}` };
  }
}

async function ingestIntercept({ url, status, body }) {
  if (status !== 200 || !body) return;
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return;
  }

  if (isVideoListURL(url)) {
    await ingestVideoList(json);
    await mutateState((s) => {
      s.interceptCounts.videoList += 1;
    });
  } else if (INSIGHT_RE.test(url)) {
    await ingestInsightURL(url);
    await maybeIngestInsightPayload(json);
    await mutateState((s) => {
      s.interceptCounts.insight += 1;
    });
  } else if (PROFILE_RE.test(url) || ACCOUNT_INFO_RE.test(url)) {
    await ingestProfileURL(url);
    await ingestProfile(json);
    await mutateState((s) => {
      s.interceptCounts.profile += 1;
    });
  }
}

async function recordURL(url, method) {
  if (!url) return;
  const stripped = stripQueryKeys(url, [
    '_signature', 'msToken', 'X-Bogus', 'X-Gnarly', 'webcast_language',
    'priority_region', 'device_id', 'webcast_sdk_version', 'tz_name', 'tz_offset',
    'screen_width', 'screen_height', 'browser_online', 'cookie_enabled',
    'browser_language', 'browser_platform', 'browser_name', 'browser_version',
    'history_len', 'verifyFp', 'WebIdLastTime', 'data_collection_enabled'
  ]);
  await mutateState((s) => {
    const list = s.recentURLs;
    const exists = list.find((u) => u.url === stripped);
    if (exists) {
      exists.count = (exists.count || 1) + 1;
      exists.last = Date.now();
    } else {
      list.push({ url: stripped, method, count: 1, last: Date.now() });
      if (list.length > MAX_RECENT_URLS) list.splice(0, list.length - MAX_RECENT_URLS);
    }
  });
}

async function ingestVideoList(json) {
  const items = extractVideoListItems(json);
  if (items.length === 0) {
    await mutateState((s) => {
      if (!s.lastVideoListSample) s.lastVideoListSample = snapshotShape(json);
    });
    return;
  }
  await mutateState((s) => {
    for (const raw of items) {
      const f = extractItemFields(raw);
      if (!f) continue;
      const existing = s.videos[f.aweme_id] || {};
      s.videos[f.aweme_id] = {
        aweme_id: f.aweme_id,
        create_time: f.create_time ?? existing.create_time,
        desc: f.desc ?? existing.desc,
        duration_ms: f.duration_ms ?? existing.duration_ms,
        comment_count: f.comment_count ?? existing.comment_count,
        digg_count: f.digg_count ?? existing.digg_count,
        share_count: f.share_count ?? existing.share_count,
        cover_url: f.cover_url ?? existing.cover_url
      };
    }
  });
}

function extractVideoListItems(json) {
  if (!json || typeof json !== 'object') return [];
  const direct = [
    json.item_list,
    json.itemList,
    json.aweme_list,
    json.video_list,
    json.items,
    json.data?.item_list,
    json.data?.itemList,
    json.data?.aweme_list,
    json.data?.video_list,
    json.data?.items,
    json.data?.video_info_list,
    json.video_info_list
  ];
  for (const c of direct) {
    if (Array.isArray(c) && c.length > 0) return c;
  }
  const queue = [json];
  let guard = 0;
  while (queue.length && guard++ < 2000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      const first = node.find((v) => v && typeof v === 'object');
      if (first && looksLikeVideoItem(first)) return node;
      for (const v of node) queue.push(v);
    } else {
      for (const v of Object.values(node)) queue.push(v);
    }
  }
  return [];
}

function looksLikeVideoItem(obj) {
  return !!(
    obj.aweme_id ||
    obj.item_id ||
    obj.aweme_detail?.aweme_id ||
    obj.item?.aweme_id ||
    obj.item_info?.aweme_id ||
    (obj.id && (obj.create_time || obj.createTime || obj.statistics))
  );
}

function extractItemFields(item) {
  if (!item || typeof item !== 'object') return null;
  const inner = item.aweme_detail || item.item || item.item_info || item;
  const rawId = inner.aweme_id ?? inner.item_id ?? inner.id;
  if (!rawId) return null;
  const stats = inner.statistics || inner.stats || {};
  return {
    aweme_id: String(rawId),
    create_time: inner.create_time ?? inner.createTime ?? null,
    desc: inner.desc ?? inner.caption ?? inner.text ?? null,
    duration_ms: inner.video?.duration ?? inner.duration ?? null,
    comment_count: stats.comment_count ?? inner.comment_count ?? null,
    digg_count: stats.digg_count ?? inner.digg_count ?? null,
    share_count: stats.share_count ?? inner.share_count ?? null,
    cover_url:
      inner.video?.cover?.url_list?.[0] ??
      inner.cover?.url_list?.[0] ??
      inner.cover_url ??
      null
  };
}

function snapshotShape(value, depth = 0) {
  if (depth > 4) return '…';
  if (value == null) return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return { __array_len: value.length, __sample: snapshotShape(value[0], depth + 1) };
  }
  if (typeof value !== 'object') return typeof value;
  const out = {};
  for (const k of Object.keys(value).slice(0, 30)) {
    out[k] = snapshotShape(value[k], depth + 1);
  }
  return out;
}

async function ingestInsightURL(url) {
  const template = stripQueryKeys(url, ['type_requests']);
  await mutateState((s) => {
    if (!s.insightTemplate) s.insightTemplate = template;
  });
}

async function ingestProfileURL(url) {
  await mutateState((s) => {
    if (!s.profileTemplate) s.profileTemplate = url.split('#')[0];
  });
}

async function maybeIngestInsightPayload(_json) {
  // Passive insight responses fired by the user are captured here; we do not yet
  // map them into rows because the orchestrated export drives its own fetches and
  // parses synchronously. Hook reserved for the X-Bogus fallback path.
}

async function ingestProfile(json) {
  const data = json?.data || json;
  const user = data?.user || data;
  if (!user) return;
  const followerCount =
    user.follower_count ?? user.followerCount ?? user.statistics?.follower_count;
  const createTime = user.create_time ?? user.createTime ?? user.account_create_time;
  const uniqueId = user.unique_id ?? user.uniqueId ?? user.username;
  const uid = user.uid ?? user.id;
  await mutateState((s) => {
    s.profile = {
      follower_count: followerCount ?? s.profile?.follower_count ?? null,
      account_created_time: createTime ?? s.profile?.account_created_time ?? null,
      creator_handle: uniqueId ?? s.profile?.creator_handle ?? null,
      creator_uid: uid ?? s.profile?.creator_uid ?? null
    };
  });
}

function stripQueryKeys(url, keys) {
  try {
    const u = new URL(url);
    keys.forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url;
  }
}

function buildInsightURL(template, awemeId) {
  const base = template || DEFAULT_INSIGHT_BASE;
  const typeRequests = INSIGH_TYPES.map((t) => ({ insigh_type: t, aweme_id: awemeId }));
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}type_requests=${encodeURIComponent(JSON.stringify(typeRequests))}`;
}

async function startExport(dateRange, tabId) {
  if (!tabId) return { ok: false, error: 'Missing tabId' };

  await mutateState((s) => {
    s.phase = 'collecting-list';
    s.dateRange = dateRange;
    s.activeTabId = tabId;
    s.rows = [];
    s.skipped = [];
    s.progress = { current: 0, total: 0, message: 'Scrolling to load video list...' };
    s.startedAt = Date.now();
    s.finishedAt = null;
    s.error = null;
  });

  runExport(tabId).catch(async (err) => {
    console.error('[tt-exporter] export failed', err);
    await mutateState((s) => {
      s.phase = 'error';
      s.error = String(err?.message || err);
    });
  });

  return { ok: true };
}

async function runExport(tabId) {
  await sendToTab(tabId, { type: 'scroll-to-bottom' });

  let state = await getState();
  if (state.phase === 'cancelled') return;

  const filtered = filterVideosByDate(state.videos, state.dateRange);
  if (filtered.length === 0) {
    await mutateState((s) => {
      s.phase = 'done';
      s.progress.message = 'No videos found in selected date range';
      s.finishedAt = Date.now();
    });
    return;
  }

  if (filtered.length > MAX_VIDEOS) {
    await mutateState((s) => {
      s.progress.message = `Capped at ${MAX_VIDEOS} videos (had ${filtered.length})`;
    });
    filtered.length = MAX_VIDEOS;
  }

  await mutateState((s) => {
    s.phase = 'fetching-insights';
    s.progress = { current: 0, total: filtered.length, message: 'Fetching insights...' };
  });

  for (let i = 0; i < filtered.length; i++) {
    state = await getState();
    if (state.phase === 'cancelled') return;

    const video = filtered[i];
    const row = await fetchInsightRow(tabId, video, state.insightTemplate);

    await mutateState((s) => {
      if (row.ok) {
        s.rows.push(row.row);
      } else {
        s.skipped.push({ aweme_id: video.aweme_id, reason: row.reason });
      }
      s.progress.current = i + 1;
      s.progress.message = `Processed ${i + 1} of ${filtered.length}`;
    });

    if (i < filtered.length - 1) {
      const jitter = (Math.random() * 2 - 1) * PER_INSIGHT_JITTER_MS;
      await sleep(PER_INSIGHT_DELAY_MS + jitter);
    }
  }

  await mutateState((s) => {
    s.phase = 'fetching-profile';
    s.progress.message = 'Fetching creator profile...';
  });

  state = await getState();
  const profileURL = state.profileTemplate || DEFAULT_PROFILE_URL;
  const profileRes = await sendToTab(tabId, { type: 'page-fetch', url: profileURL }).catch(
    (err) => ({ ok: false, error: String(err) })
  );
  if (profileRes?.ok && profileRes.body) {
    try {
      await ingestProfile(JSON.parse(profileRes.body));
    } catch (_e) { /* ignore */ }
  }

  await mutateState((s) => {
    if (s.profile) {
      const created = formatUnixDate(s.profile.account_created_time);
      for (const row of s.rows) {
        row.follower_count = s.profile.follower_count ?? row.follower_count ?? '';
        row.account_created_date = created ?? row.account_created_date ?? '';
        if (!row.creator_uid) row.creator_uid = s.profile.creator_uid ?? '';
        if (!row.creator_handle) row.creator_handle = s.profile.creator_handle ?? '';
      }
    }
    s.phase = 'done';
    s.progress.message = `Done. ${s.rows.length} rows, ${s.skipped.length} skipped.`;
    s.finishedAt = Date.now();
  });
}

function filterVideosByDate(videos, dateRange) {
  const entries = Object.values(videos);
  if (!dateRange?.start && !dateRange?.end) return entries.slice().sort(byCreateTimeDesc);
  const startSec = dateRange?.start ? localDayBoundarySec(dateRange.start, false) : null;
  const endSec = dateRange?.end ? localDayBoundarySec(dateRange.end, true) : null;
  return entries
    .filter((v) => {
      if (!v.create_time) return false;
      if (startSec != null && v.create_time < startSec) return false;
      if (endSec != null && v.create_time > endSec) return false;
      return true;
    })
    .sort(byCreateTimeDesc);
}

function localDayBoundarySec(dateStr, endOfDay) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  return Math.floor(dt.getTime() / 1000);
}

function byCreateTimeDesc(a, b) {
  return (b.create_time ?? 0) - (a.create_time ?? 0);
}

async function singleVideoFetch(tabId, awemeId) {
  if (!tabId) return { ok: false, error: 'Missing tabId' };
  if (!awemeId) return { ok: false, error: 'Missing aweme_id' };
  const normalized = String(awemeId).trim();
  const id = extractAwemeId(normalized);
  if (!id) return { ok: false, error: 'Could not parse aweme_id from input' };

  const state = await getState();
  const url = buildInsightURL(state.insightTemplate, id);
  const t0 = Date.now();
  let res;
  try {
    res = await sendToTab(tabId, { type: 'page-fetch', url });
  } catch (err) {
    return { ok: false, error: String(err), url };
  }
  const elapsed = Date.now() - t0;
  if (!res?.ok || !res.body) {
    return { ok: false, error: res?.error || 'fetch failed', url, elapsed };
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch (err) {
    return { ok: false, error: 'invalid JSON', url, elapsed, rawSnippet: res.body.slice(0, 400) };
  }

  const parsed = parseInsightResponse(json, { aweme_id: id, create_time: null });
  return {
    ok: true,
    awemeId: id,
    url,
    elapsed,
    status: res.status,
    row: parsed.ok ? parsed.row : null,
    parseError: parsed.ok ? null : parsed.reason,
    raw: json
  };
}

function extractAwemeId(input) {
  if (/^\d{6,}$/.test(input)) return input;
  const m = input.match(/(?:\/video\/|\/photo\/|aweme_id=|item_id=)(\d{6,})/);
  if (m) return m[1];
  const lone = input.match(/(\d{15,25})/);
  if (lone) return lone[1];
  return null;
}

async function fetchInsightRow(tabId, video, template) {
  const url = buildInsightURL(template, video.aweme_id);
  let res = await sendToTab(tabId, { type: 'page-fetch', url }).catch(
    (err) => ({ ok: false, error: String(err) })
  );

  if (!res?.ok) {
    await sleep(INSIGHT_RETRY_DELAY_MS);
    res = await sendToTab(tabId, { type: 'page-fetch', url }).catch(
      (err) => ({ ok: false, error: String(err) })
    );
  }

  if (!res?.ok || !res.body) {
    return { ok: false, reason: res?.error || 'fetch failed' };
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch (err) {
    return { ok: false, reason: 'invalid JSON' };
  }

  return parseInsightResponse(json, video);
}

function parseInsightResponse(json, video) {
  const data = json?.data || json;
  if (!data) return { ok: false, reason: 'empty response' };

  const statusFlag = data?.status ?? json?.status;
  const dataQualityIssues = [];
  if (statusFlag === 2) dataQualityIssues.push('insufficient_data');

  const videoInfo =
    data?.video_info ||
    data?.aweme_info ||
    findFirstByKey(data, 'video_info') ||
    {};

  const stats = videoInfo?.statistics || {};

  const retention = findInsight(data, 'video_retention_rate_realtime');
  const perDuration = findInsight(data, 'video_per_duration_realtime');
  const finishRate = findInsight(data, 'video_finish_rate_realtime');
  const trafficSource = findInsight(data, 'video_traffic_source_percent_realtime');
  const newFollowers = findInsight(data, 'video_new_followers');
  const totalViews = findInsight(data, 'realtime_total_video_views');

  const ecr = readRetentionAt(retention, '5000');
  if (ecr == null && statusFlag !== 2) dataQualityIssues.push('missing_ecr');

  const avgWatchTimeS = readNumericValue(perDuration);
  const durationMs = videoInfo?.video?.duration ?? videoInfo?.duration ?? video.duration_ms ?? null;
  const nawp =
    avgWatchTimeS != null && durationMs
      ? avgWatchTimeS / (durationMs / 1000)
      : null;

  const traffic = readTrafficSources(trafficSource);

  const createTs = videoInfo?.create_time ?? video.create_time;
  const row = {
    video_id: video.aweme_id,
    post_date: formatUnixDate(createTs),
    post_time: formatUnixTime(createTs),
    caption: videoInfo?.desc ?? video.desc ?? '',
    duration_ms: durationMs ?? video.duration_ms ?? '',
    views: readNumericValue(totalViews) ?? stats.play_count ?? '',
    likes: stats.digg_count ?? video.digg_count ?? '',
    comments: stats.comment_count ?? video.comment_count ?? '',
    shares: stats.share_count ?? video.share_count ?? '',
    ECR: ecr ?? '',
    avg_watch_time_s: avgWatchTimeS ?? '',
    NAWP: nawp != null ? roundTo(nawp, 6) : '',
    watched_full_pct: readNumericValue(finishRate) ?? '',
    traffic_foryou_pct: traffic.foryou ?? '',
    traffic_follow_pct: traffic.follow ?? '',
    traffic_profile_pct: traffic.profile ?? '',
    traffic_search_pct: traffic.search ?? '',
    new_followers: readNumericValue(newFollowers) ?? '',
    creator_uid: videoInfo?.author?.uid ?? '',
    creator_handle: videoInfo?.author?.unique_id ?? '',
    follower_count: '',
    account_created_date: '',
    data_quality: dataQualityIssues.join('|')
  };

  return { ok: true, row };
}

function findInsight(data, insighType) {
  if (!data || typeof data !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(data, insighType)) return data[insighType];

  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') {
          if (item.insigh_type === insighType || item.insight_type === insighType) return item;
          stack.push(item);
        }
      }
    } else {
      if (Object.prototype.hasOwnProperty.call(node, insighType)) return node[insighType];
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

function findFirstByKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
    } else {
      for (const k of Object.keys(node)) stack.push(node[k]);
    }
  }
  return null;
}

function readNumericValue(node) {
  if (node == null) return null;
  const v = node?.value;
  if (v == null) return null;
  if (typeof v === 'object' && 'value' in v) {
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readRetentionAt(node, timestamp) {
  const list = node?.value?.list ?? node?.value?.value?.list ?? node?.list;
  if (!Array.isArray(list)) return null;
  const target = String(timestamp);
  const entry = list.find((e) => String(e?.timestamp) === target);
  if (!entry) return null;
  const v = entry.value;
  const n = Number(typeof v === 'object' ? v?.value : v);
  return Number.isFinite(n) ? n : null;
}

function readTrafficSources(node) {
  const out = { foryou: null, follow: null, profile: null, search: null };
  const list = node?.value?.value ?? node?.value?.list ?? node?.value;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const key = (entry?.key ?? entry?.name ?? '').toString();
    const val = Number(entry?.value ?? entry?.percent ?? 0);
    if (!Number.isFinite(val)) continue;
    const norm = key.toLowerCase();
    if (norm === 'for you') out.foryou = val;
    else if (norm === 'follow') out.follow = val;
    else if (norm === 'personal profile') out.profile = val;
    else if (norm === 'search') out.search = val;
  }
  return out;
}

function formatUnixDate(unixSeconds) {
  if (!unixSeconds) return '';
  const ms = unixSeconds > 1e12 ? unixSeconds : unixSeconds * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatUnixTime(unixSeconds) {
  if (!unixSeconds) return '';
  const ms = unixSeconds > 1e12 ? unixSeconds : unixSeconds * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function roundTo(n, decimals) {
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        reject(new Error(lastErr.message));
        return;
      }
      resolve(response);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
