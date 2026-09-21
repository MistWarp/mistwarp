# MistWarp realtime

Cloudflare Worker and Durable Object transport for MistWarp Games rooms. The
MistWarp API issues a one-use, one-minute ticket; this service verifies it and
places the signed-in player in a room isolated by project, project version,
play/editor context, and room name.

Before deploying, set the same random secret here and on `mistwarp-api` as
`REALTIME_SERVICE_KEY`:

```sh
npx wrangler secret put REALTIME_SERVICE_KEY
npm run deploy
```

Production routes both `wss://api.mistwarp.org/v1/connect` and the legacy
`wss://mwapi.mistium.com/v1/connect` endpoint to this Worker. Other paths on
either API hostname continue to use the API origin. Local development also
requires matching `API_URL` and `ALLOWED_ORIGINS` values in `wrangler.jsonc`.
