# YouTube Creator Research

Search for a YouTube creator by exact channel name and see their uploads from the last 1/2/4 weeks.

## Setup

### Backend
```
cd backend
npm install
```
Edit `backend/.env` and set `YOUTUBE_API_KEY=<your key>` (get one from Google Cloud Console with the YouTube Data API v3 enabled).

```
npm run dev
```
Runs on http://localhost:5000

### Frontend
```
cd frontend
npm install
npm run dev
```
Runs on http://localhost:5173 and proxies `/api` requests to the backend.

## How it works
1. Enter a creator's exact channel name and pick a timeframe (1/2/4 weeks).
2. Click Fetch — the frontend calls `POST /api/creator-search`, which resolves the exact channel (breaking ties by subscriber count), then calls `POST /api/recent-videos` with the resolved `channelId`.
3. Matching videos are rendered as cards with thumbnail, title, view count, and time since published.
