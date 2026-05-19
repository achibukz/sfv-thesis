# My TikTok Analytics Backup

A small Chrome extension for **TikTok creators who want a personal copy of
their own Studio analytics**. One click and you get a CSV of your videos and
their performance numbers that you can keep, open in Excel / Google Sheets,
review on your own time, or compare across months.

This is a personal-use tool. The extension only ever reads the TikTok pages
**you** are signed into in your own browser — it never logs into anyone else's
account and never sends your data anywhere on its own. The CSV is downloaded
straight to your computer.

## Why creators use it

- Keep your own backup. TikTok's UI only shows insights for a limited time
  window — exporting once a month means you never lose long-tail performance
  data.
- Spreadsheet-friendly. The CSV opens in Excel / Numbers / Google Sheets, so
  you can build your own dashboards or charts on top of your data.
- Spot patterns. Engagement Continuation Rate (the % of viewers who stay past
  5 seconds) and Normalized Average Watch Percentage (average watch time
  divided by video length) are easier to compare in a sheet than by clicking
  one video at a time.

## What ends up in the CSV

For every one of your own videos in the date range you pick:

```
video_id, post_date, caption, duration_ms,
views, likes, comments, shares,
ECR, avg_watch_time_s, NAWP, watched_full_pct,
traffic_foryou_pct, traffic_follow_pct, traffic_profile_pct, traffic_search_pct,
new_followers, creator_uid, creator_handle, follower_count, account_created_date,
data_quality
```

- **ECR** comes from `video_retention_rate_realtime` at 5000 ms — the % of
  viewers still watching at the 5-second mark.
- **NAWP** = `avg_watch_time_s / (duration_ms / 1000)` — average watch time
  normalised by video length.

## How it works (short)

```
TikTok Studio page (signed in as you)
  └─ injected.js — runs in the page, watches the analytics API
        ↓
     content.js — relays page messages to the extension worker
        ↓
     background.js — collects video IDs, asks the page to fetch insights
        ↓
     popup.html / popup.js — UI, date range, CSV download
```

Manifest V3 cannot read network response bodies directly, so the extension
patches `fetch` and `XMLHttpRequest` *inside the TikTok tab you opened* and
re-broadcasts their JSON bodies. The orchestrated insight calls reuse your
existing TikTok session — the extension never holds your password or token.

## Install (developer mode)

### English

1. Clone or download this repository.
2. Open Chrome → visit `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** → select the `tiktok-analytics-exporter/` folder.
5. Pin the extension (puzzle-piece icon → pin **My TikTok Analytics Backup**).
6. Visit `https://www.tiktok.com/tiktokstudio/content` and sign in to your own
   account.
7. Click the extension icon. Pick a date range, click **Start export**.
8. When the run finishes, click **Download CSV** to save it to your computer.

Chrome will show a banner that says *"Disable developer mode extensions"*.
That's expected for unpacked extensions — leave it enabled while you run
the export.

### Filipino

1. I-clone o i-download ang repo na ito.
2. Buksan ang Chrome → pumunta sa `chrome://extensions`.
3. I-on ang **Developer mode** (kanang-itaas).
4. I-click ang **Load unpacked** → piliin ang `tiktok-analytics-exporter/`
   folder.
5. I-pin ang extension (puzzle icon → i-pin ang **My TikTok Analytics
   Backup**).
6. Pumunta sa `https://www.tiktok.com/tiktokstudio/content` at mag-sign in sa
   sarili mong account.
7. I-click ang extension icon. Pumili ng date range, i-click ang **Start
   export**.
8. Pagkatapos, i-click ang **Download CSV** para i-save sa computer mo.

May lalabas na *"Disable developer mode extensions"* warning sa Chrome — okay
lang iyon habang ginagamit mo ang extension.

## How a run works

1. The popup confirms you're on your own TikTok Studio page.
2. The content script slow-scrolls the Studio video list while TikTok lazily
   loads each page of the `item_list` API. The extension accumulates video IDs
   and post dates.
3. The list is filtered by your chosen date range (interpreted in your local
   timezone) and capped at 2 000 videos.
4. For each video the extension asks the page to call the analytics API in
   your authenticated context. A 2 s ± 500 ms pause separates calls; failed
   calls are retried once after 3 s.
5. After all videos are processed, the extension fetches your profile once to
   fill `follower_count` and `account_created_date`.
6. Click **Download CSV** to save the file as
   `tiktok_analytics_<your_handle>_<YYYY-MM-DD>.csv`.

Run state lives in `chrome.storage.session` and is wiped when you close the
browser. The **Reset** button clears it manually.

## Privacy & scope

- Reads only the TikTok tabs you have open.
- Never transmits your data to any server controlled by the extension author.
- The CSV is created and downloaded locally — what you do with it afterwards
  is up to you.
- Only video posts are exported (carousels / photo posts are skipped).
- Videos under ~24 h old may flag `data_quality=insufficient_data`.

## Troubleshooting

- **"video_list hits" climbs but "Videos seen" stays at 0** — TikTok shipped a
  new response shape. Open the **Debug** tab in the popup; an expandable
  section will show the top-level keys of the most recent unparsed payload.
  Share that snapshot if you'd like help adding support.
- **Run finds zero videos in your range** — check that your selected dates
  actually contain posts, and that you've fully scrolled the list at least
  once. The extension waits for Studio to finish paginating before filtering.

## Development

Plain HTML/CSS/JS — no build step. Edit a file, then hit **Reload** on the
entry in `chrome://extensions`.

Debug logs live in three places:

- Popup: right-click the popup → **Inspect**
- Content / injected scripts: DevTools on the TikTok Studio tab
- Service worker: `chrome://extensions` → **Service worker** link under the
  extension card
