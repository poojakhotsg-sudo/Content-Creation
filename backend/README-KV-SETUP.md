# Provisioning Redis (Upstash) for Watch Video Analyzer job storage

This app's Watch Video Analyzer stores background-job state in Redis instead
of in-memory, so status polling works correctly across Vercel's serverless
instances. Provisioning the actual database requires your Vercel account —
here's exactly how to do it.

## 1. Install the Vercel CLI and log in

```
npm install -g vercel
vercel login
```

(`vercel login` opens a browser for auth — if you're doing this from inside a
Claude Code session, run it yourself via `!vercel login` so the interactive
prompt reaches your terminal, not the agent.)

## 2. Link this project (if not already linked)

From the repo root:

```
vercel link
```

## 3. Create the Redis database

In the Vercel dashboard: your project → **Storage** tab → **Create Database**
→ **Redis** (this provisions an Upstash Redis instance via Vercel Marketplace
— "Vercel KV" as a standalone product is deprecated, this is its replacement).

Or via CLI:

```
vercel storage create
```
and choose Redis when prompted.

## 4. Connect it to this project

In the dashboard, on the new database's page, click **Connect Project** and
select this project (all environments: Production, Preview, Development).

## 5. Pull the credentials into local dev

```
vercel env pull backend/.env.vercel
```

This writes `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (among
other vars) to `backend/.env.vercel`. Copy just those two lines into
`backend/.env` (the file `dotenv` actually loads) — don't commit either file
if the project's `.gitignore` doesn't already exclude `.env` files.

## 6. Verify

Start the backend (`npm run dev` in `backend/`) and check the startup log —
if the two env vars are missing, `@upstash/redis` prints a warning
(`[Upstash Redis] Unable to find environment variable...`) on first use
rather than crashing the server. Once both are set, that warning goes away
and `/api/watch-video` + `/api/watch-status/:jobId` work end-to-end.

## Production

Since the database was connected to this Vercel project in step 4, Vercel
automatically injects the same env vars into the deployed serverless
functions — no separate configuration needed there.
