# MistWarp status Worker

This Cloudflare Worker checks MistWarp every five minutes from outside the main deployment. Current status, 31 days of hourly availability totals and incident notices live in Workers KV. The Worker has no D1 binding or SQL queries.

## Storage and caching

- Each five-minute cron writes `status:v1` and `history:v1`, for 576 KV writes per day. Incident creation and edits each add one write. The cron lists the newest 20 incident keys once per run, for 288 list operations per day.
- Keep one scheduled Worker as the history writer. KV does not support atomic read-modify-write across concurrent writers. Incident records have separate keys so concurrent creates cannot overwrite each other.
- Hourly history keeps sample counts, operational counts and latency sums. Responses calculate uptime and latency from those totals. The requested window includes its partial starting hour.
- The Worker explicitly caches status responses at the edge for 60 seconds and history for 300 seconds. Cache keys normalize the hours parameter and ignore unrelated query parameters. CORS headers are added after the cache lookup.
- KV changes can take about a minute to propagate. Edge caching adds up to another minute for status or five minutes for history. Incident edits appear in the next five-minute status snapshot after KV propagation.
- `generatedAt` reports the check snapshot time. Checks older than 15 minutes display as unknown. Missing snapshots return an uncached 503.

Cloudflare documents the [KV free limits](https://developers.cloudflare.com/kv/platform/limits/) and [KV consistency behavior](https://developers.cloudflare.com/kv/concepts/how-kv-works/). Limits are shared with other Workers on the account.

## Deploy

1. Run `npm install`.
2. For a new account, run `npx wrangler kv namespace create STATUS_KV` and put its ID in `wrangler.jsonc`. The existing deployment already has a namespace configured.
3. Add the admin secret with `npx wrangler secret put ADMIN_TOKEN`.
4. Before the first deployment, run `npm run kv:init` to take fresh health checks and initialize empty history. The script refuses to overwrite existing snapshots. Alternatively, the first scheduled run initializes the snapshots automatically.
5. Run `npm run deploy`. The configuration connects `status.warp.mistium.com` as a custom domain. Later deployments do not need to initialize KV again.

`CHECKS_JSON` controls the monitored services. Each entry needs an `id`, `name`, and HTTPS `url`. Change `ALLOWED_ORIGINS` for preview deployments. The Worker also accepts the legacy singular `ALLOWED_ORIGIN` variable.

The previous D1 database was deleted before migration. Historical checks, incident records and analytics from that database are unavailable. KV history starts with fresh checks. The Worker no longer collects browser analytics.

## Endpoints

- `GET /v1/status` returns the newest check and recent incidents.
- `GET /v1/history?hours=168` returns hourly uptime and latency. Hours are whole numbers clamped to 1 through 720.
- `POST /v1/incidents` requires `Authorization: Bearer <ADMIN_TOKEN>` and creates an incident notice. The response includes its opaque string `id`.
- `PATCH /v1/incidents/:id` requires the same token and updates or resolves an incident. Each record remains in KV for later editing. Edits to the same incident follow KV's last-write-wins consistency and one-write-per-second limit.
- `POST /v1/events` and authorized `GET /v1/metrics` return HTTP 410 with `analytics disabled`. They do not access storage.

## Verify

Run `npm test` and `npx wrangler deploy --dry-run`. Tests cover history totals and retention, missing and stale snapshots, CORS isolation in the edge cache, concurrent incident creation and disabled analytics.
