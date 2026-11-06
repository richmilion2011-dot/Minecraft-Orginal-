# VoxelWorld — Cloudflare Workers multiplayer backend

This folder replaces the previous Node.js `server/` backend. It is designed for Cloudflare Workers + a SQLite-backed Durable Object. The static game remains in `../web` and can stay on Netlify.

## Deploy

1. Create a GitHub repository and upload the contents of this project (keep `web/` and `cloudflare/`).
2. In Cloudflare Dashboard, open **Workers & Pages → Create → Workers** and connect the GitHub repository using Workers Builds.
3. Set the build/deploy working directory to `cloudflare` (or configure the build command to `cd cloudflare && npm install && npm run deploy`, depending on the build UI).
4. Deploy with `npm install` and `npm run deploy` from this `cloudflare/` directory. Wrangler applies the SQLite Durable Object migration from `wrangler.toml`.
5. Open the Worker URL, for example `https://voxelworld-multiplayer.<your-subdomain>.workers.dev`. The health endpoint should return JSON.
6. In the game menu's server field, enter `wss://voxelworld-multiplayer.<your-subdomain>.workers.dev/ws` (replace with your actual Worker hostname). Create a room and share its code.

If deploying through the Wrangler CLI, run these commands inside `cloudflare/`:

```bash
npm install
npx wrangler login
npm run deploy
```

## Architecture

- `web/` is the static HTML5 game; keep it on Netlify.
- This Worker accepts WebSocket connections at `/ws`.
- A SQLite Durable Object stores room worlds and player profiles. Room data remains after players, including the creator, disconnect.
- Room limit is 20 simultaneous players. This is an application limit, not a performance guarantee.

## Free plan notes

Cloudflare has a Free plan, but Workers and Durable Objects have usage quotas and limits. The Worker is not guaranteed to support 20 players under all traffic patterns. Watch usage in the Cloudflare dashboard. Do not enable paid billing or paid features if you need to keep the project at €0. If a limit is exceeded, requests may fail until the quota resets or the plan is changed.

## Important

This is an initial port. The previous Node.js server used a local JSON file; this version uses Durable Object SQLite storage instead. The game client already speaks JSON over WebSocket, so no game protocol changes are needed. Test with two devices before sharing widely. There is no full account system, moderation, rate limiting, or backup/export UI yet. Keep a copy of the deployed source and periodically export important world data before relying on it as the only save.
