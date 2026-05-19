(() => {
  if (window.__ttExporterInstalled) return;
  window.__ttExporterInstalled = true;

  const ORIGINAL_FETCH = window.fetch.bind(window);
  const OriginalXHROpen = XMLHttpRequest.prototype.open;
  const OriginalXHRSend = XMLHttpRequest.prototype.send;

  const INTERCEPT_PATTERNS = [
    /\/tiktok\/creator\/manage\/item_list\//i,
    /\/aweme\/v\d+\/web\/aweme\/post\//i,
    /\/api\/post\/item_list\//i,
    /\/aweme\/post\//i,
    /\/aweme\/v\d+\/data\/insight\//i,
    /\/aweme\/v\d+\/user\/profile\/self\//i,
    /\/passport\/web\/account_info\//i,
    /\/tiktokstudio\/api\//i
  ];

  const URL_LOG_PATTERN = /tiktok\.com\/(api|aweme|tiktok|tiktokstudio|passport)\//i;

  const shouldIntercept = (url) => {
    if (!url) return false;
    return INTERCEPT_PATTERNS.some((re) => re.test(url));
  };

  const postResponse = (url, body, status) => {
    window.postMessage(
      { source: 'tt-exporter-injected', kind: 'response', url, body, status },
      window.location.origin
    );
  };

  const postUrlSeen = (url, method) => {
    if (!url || !URL_LOG_PATTERN.test(url)) return;
    window.postMessage(
      { source: 'tt-exporter-injected', kind: 'url-seen', url, method },
      window.location.origin
    );
  };

  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    postUrlSeen(url, method);
    const response = await ORIGINAL_FETCH(input, init);
    if (shouldIntercept(url)) {
      try {
        const clone = response.clone();
        clone.text().then((text) => postResponse(url, text, response.status)).catch(() => {});
      } catch (_e) { /* ignore */ }
    }
    return response;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__ttExporterUrl = url;
    this.__ttExporterMethod = (method || 'GET').toUpperCase();
    postUrlSeen(typeof url === 'string' ? url : url?.toString?.(), this.__ttExporterMethod);
    return OriginalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener('load', () => {
      const url = this.__ttExporterUrl;
      if (shouldIntercept(url)) {
        try {
          postResponse(url, this.responseText, this.status);
        } catch (_e) { /* ignore */ }
      }
    });
    return OriginalXHRSend.apply(this, args);
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'tt-exporter-content') return;

    if (data.kind === 'page-fetch') {
      try {
        const res = await ORIGINAL_FETCH(data.url, {
          method: data.method || 'GET',
          credentials: 'include',
          headers: data.headers || {}
        });
        const body = await res.text();
        window.postMessage(
          {
            source: 'tt-exporter-injected',
            kind: 'page-fetch-reply',
            reqId: data.reqId,
            url: data.url,
            body,
            status: res.status
          },
          window.location.origin
        );
      } catch (err) {
        window.postMessage(
          {
            source: 'tt-exporter-injected',
            kind: 'page-fetch-reply',
            reqId: data.reqId,
            error: String(err)
          },
          window.location.origin
        );
      }
    }
  });
})();
