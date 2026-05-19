const SCROLL_INTERVAL_MS = 1500;
const SCROLL_JITTER_MS = 500;
const SCROLL_STALL_LIMIT = 3;
const MAX_SCROLL_CYCLES = 400;

const pendingPageFetches = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'tt-exporter-injected') return;

  if (data.kind === 'response') {
    try {
      chrome.runtime
        .sendMessage({
          type: 'intercepted-response',
          url: data.url,
          status: data.status,
          body: data.body
        })
        .catch(() => {});
    } catch (_e) { /* service worker may be transient */ }
    return;
  }

  if (data.kind === 'url-seen') {
    try {
      chrome.runtime
        .sendMessage({ type: 'url-seen', url: data.url, method: data.method })
        .catch(() => {});
    } catch (_e) { /* ignore */ }
    return;
  }

  if (data.kind === 'page-fetch-reply') {
    const pending = pendingPageFetches.get(data.reqId);
    if (!pending) return;
    pendingPageFetches.delete(data.reqId);
    if (pending.timer) clearTimeout(pending.timer);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve({ body: data.body, status: data.status });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'scroll-to-bottom') {
    scrollToBottom(msg.maxCycles ?? MAX_SCROLL_CYCLES).then(
      (info) => sendResponse({ ok: true, ...info }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }
  if (msg?.type === 'page-fetch') {
    pageFetch(msg.url, msg.headers).then(
      (out) => sendResponse({ ok: true, ...out }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }
  if (msg?.type === 'is-studio-page') {
    sendResponse({ ok: true, isStudio: isStudioContentPage() });
    return false;
  }
});

function isStudioContentPage() {
  return /\/(creator-center|tiktokstudio)\/content/i.test(window.location.pathname);
}

function pageFetch(url, headers) {
  const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingPageFetches.has(reqId)) {
        pendingPageFetches.delete(reqId);
        reject(new Error('page-fetch timeout'));
      }
    }, 30000);
    pendingPageFetches.set(reqId, { resolve, reject, timer });
    window.postMessage(
      { source: 'tt-exporter-content', kind: 'page-fetch', reqId, url, headers, method: 'GET' },
      window.location.origin
    );
  });
}

async function scrollToBottom(maxCycles) {
  let stable = 0;
  let cycles = 0;
  let lastHeight = -1;

  while (cycles < maxCycles && stable < SCROLL_STALL_LIMIT) {
    const beforeHeight = document.documentElement.scrollHeight;
    window.scrollTo({ top: beforeHeight, behavior: 'smooth' });
    await sleep(SCROLL_INTERVAL_MS + (Math.random() * 2 - 1) * SCROLL_JITTER_MS);
    const afterHeight = document.documentElement.scrollHeight;
    if (afterHeight === lastHeight) {
      stable += 1;
    } else {
      stable = 0;
      lastHeight = afterHeight;
    }
    cycles += 1;
  }
  return { cycles, finalHeight: document.documentElement.scrollHeight };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
