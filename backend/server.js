require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
// Not a secret — just identifies which Apify actor to call. Fill in the real ID.
const APIFY_TRANSCRIPT_ACTOR_ID = 'pintostudio~youtube-transcript-scraper';
const APIFY_INSTAGRAM_POSTS_ACTOR_ID = 'unseenuser~ig-posts';
const APIFY_INSTAGRAM_TRANSCRIPT_ACTOR_ID = 'crawlerbros~instagram-transcript-scraper';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'openai/gpt-oss-120b';

if (!YOUTUBE_API_KEY) {
  console.warn('WARNING: YOUTUBE_API_KEY is not set in .env');
}
if (!APIFY_API_TOKEN) {
  console.warn('WARNING: APIFY_API_TOKEN is not set in .env');
}
if (!GROQ_API_KEY) {
  console.warn('WARNING: GROQ_API_KEY is not set in .env');
}
if (APIFY_TRANSCRIPT_ACTOR_ID === 'REPLACE_WITH_ACTOR_ID') {
  console.warn('WARNING: APIFY_TRANSCRIPT_ACTOR_ID constant in server.js is still a placeholder');
}

// POST /api/creator-search { creatorName }
app.post('/api/creator-search', async (req, res) => {
  const { creatorName } = req.body || {};

  if (!creatorName || typeof creatorName !== 'string' || !creatorName.trim()) {
    return res.status(400).json({ error: 'creatorName is required' });
  }

  try {
    // 1. Search for channels matching the name
    const searchResp = await axios.get(`${YT_BASE}/search`, {
      params: {
        key: YOUTUBE_API_KEY,
        q: creatorName,
        type: 'channel',
        part: 'snippet',
        maxResults: 25,
      },
    });

    const candidateIds = [
      ...new Set(
        (searchResp.data.items || []).map((item) => item.snippet.channelId || item.id.channelId)
      ),
    ].filter(Boolean);

    if (candidateIds.length === 0) {
      return res.status(404).json({ error: `No channel found matching "${creatorName}"` });
    }

    // 2. Fetch full channel details (title, thumbnail, subscriberCount) for candidates
    const channelsResp = await axios.get(`${YT_BASE}/channels`, {
      params: {
        key: YOUTUBE_API_KEY,
        id: candidateIds.join(','),
        part: 'snippet,statistics',
      },
    });

    const channels = channelsResp.data.items || [];

    // 3. Sort by subscriber count (descending). Hidden subscriber counts treated as 0.
    channels.sort((a, b) => {
      const subsA = Number(a.statistics.subscriberCount || 0);
      const subsB = Number(b.statistics.subscriberCount || 0);
      return subsB - subsA;
    });

    const mappedChannels = channels.map(ch => ({
      channelId: ch.id,
      title: ch.snippet.title,
      description: ch.snippet.description || '',
      thumbnail:
        ch.snippet.thumbnails?.high?.url ||
        ch.snippet.thumbnails?.medium?.url ||
        ch.snippet.thumbnails?.default?.url ||
        null,
      subscriberCount: Number(ch.statistics.subscriberCount || 0),
    }));

    return res.json({ channels: mappedChannels });
  } catch (err) {
    console.error('creator-search error:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Failed to search for creator on YouTube' });
  }
});

// Parses an ISO 8601 duration (e.g. "PT4M32S") into total seconds.
function parseIsoDurationToSeconds(duration) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration || '');
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

// POST /api/recent-videos { channelId, days, durationFilter }
app.post('/api/recent-videos', async (req, res) => {
  const { channelId, days, durationFilter } = req.body || {};

  if (!channelId || typeof channelId !== 'string') {
    return res.status(400).json({ error: 'channelId is required' });
  }
  const numDays = Number(days);
  if (!numDays || numDays <= 0) {
    return res.status(400).json({ error: 'days must be a positive number' });
  }
  const durFilter = ['all', 'under5', 'over5'].includes(durationFilter) ? durationFilter : 'all';

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - numDays);

  try {
    // 1. Get the channel's uploads playlist ID
    const channelResp = await axios.get(`${YT_BASE}/channels`, {
      params: {
        key: YOUTUBE_API_KEY,
        id: channelId,
        part: 'contentDetails',
      },
    });

    const uploadsPlaylistId =
      channelResp.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsPlaylistId) {
      return res.status(404).json({ error: 'Could not find uploads playlist for this channel' });
    }

    // 2. Walk the uploads playlist newest-first, stopping once we pass the cutoff
    const videosInRange = [];
    let pageToken = undefined;
    let keepPaging = true;

    while (keepPaging) {
      const playlistResp = await axios.get(`${YT_BASE}/playlistItems`, {
        params: {
          key: YOUTUBE_API_KEY,
          playlistId: uploadsPlaylistId,
          part: 'snippet,contentDetails',
          maxResults: 50,
          pageToken,
        },
      });

      const items = playlistResp.data.items || [];

      for (const item of items) {
        const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet.publishedAt;
        const publishedDate = new Date(publishedAt);

        if (publishedDate < cutoff) {
          keepPaging = false;
          break;
        }

        videosInRange.push({
          videoId: item.contentDetails?.videoId || item.snippet.resourceId?.videoId,
          title: item.snippet.title,
          publishedAt,
          thumbnail:
            item.snippet.thumbnails?.high?.url ||
            item.snippet.thumbnails?.medium?.url ||
            item.snippet.thumbnails?.default?.url ||
            null,
        });
      }

      pageToken = playlistResp.data.nextPageToken;
      if (!pageToken) keepPaging = false;
    }

    if (videosInRange.length === 0) {
      return res.json({ videos: [] });
    }

    // 3. Batch-fetch viewCount and contentDetails for all videos in range (max 50 IDs per call)
    const videoIds = videosInRange.map((v) => v.videoId).filter(Boolean);
    const viewCountMap = {};
    const durationMap = {};

    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const statsResp = await axios.get(`${YT_BASE}/videos`, {
        params: {
          key: YOUTUBE_API_KEY,
          id: batch.join(','),
          part: 'statistics,contentDetails',
        },
      });
      for (const item of statsResp.data.items || []) {
        viewCountMap[item.id] = Number(item.statistics.viewCount || 0);
        durationMap[item.id] = parseIsoDurationToSeconds(item.contentDetails?.duration);
      }
    }

    let videos = videosInRange.map((v) => ({
      ...v,
      viewCount: viewCountMap[v.videoId] ?? 0,
      durationSeconds: durationMap[v.videoId] ?? 0,
    }));

    if (durFilter === 'under5') {
      videos = videos.filter((v) => v.durationSeconds < 300);
    } else if (durFilter === 'over5') {
      videos = videos.filter((v) => v.durationSeconds >= 300);
    }

    return res.json({ videos });
  } catch (err) {
    console.error('recent-videos error:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Failed to fetch recent videos from YouTube' });
  }
});

// Converts an actor-supplied timestamp (unix seconds, unix ms, or an ISO string)
// into an ISO string. Instagram scrapers are inconsistent about which one they emit.
function toIsoDate(rawTimestamp) {
  if (!rawTimestamp) return null;
  const num = Number(rawTimestamp);
  if (Number.isFinite(num)) {
    const ms = num < 1e12 ? num * 1000 : num;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(rawTimestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Normalizes apidojo/instagram-scraper-api's dataset items into the shape the
// frontend needs. Confirmed against a real (non-demo) response: posts carry
// url, code, createdAt (ISO string), likeCount, commentCount, isVideo, and
// image.url (cover frame, present on both photo and video posts). The other
// field names are kept as fallbacks in case the actor's schema shifts.
function extractInstagramPosts(datasetItems) {
  if (!Array.isArray(datasetItems)) return [];

  return datasetItems
    .map((p) => {
      if (!p || typeof p !== 'object') return null;

      const shortcode = p.code || p.shortCode || p.shortcode || null;

      // --- Step 1: detect video from actor-supplied fields (before URL is known) ---
      const fieldIsVideo =
        p.isVideo === true ||
        p.type === 'video' ||
        p.type === 'Video' ||
        p.type === 'Reel' ||
        p.type === 'reel' ||
        Boolean(p.video?.url || p.videoUrl || p.video_url) ||
        p.productType === 'clips' ||
        p.mediaType === 'VIDEO' ||
        p.media_type === 'VIDEO';

      // --- Step 2: resolve the post URL ---
      const postUrl =
        p.url ||
        (shortcode
          ? `https://www.instagram.com/${fieldIsVideo ? 'reel' : 'p'}/${shortcode}/`
          : null);

      // --- Step 3: final isVideo — field flags OR /reel/ anywhere in the URL ---
      const isVideo = fieldIsVideo || (typeof postUrl === 'string' && postUrl.includes('/reel/'));

      const postedAt = toIsoDate(
        p.created_at || p.createdAt || p.timestamp || p.takenAt || p.taken_at ||
        p.taken_at_timestamp || p.pubDate || p.pub_date || p.postedAt || p.posted_at ||
        p.date || p.datePosted || p.uploadDate
      );

      if (!postUrl || !postedAt) return null;

      console.log(
        `[extractInstagramPosts] url=${postUrl} fieldIsVideo=${fieldIsVideo} isVideo=${isVideo} type=${p.type ?? 'n/a'}`
      );

      return {
        postUrl,
        shortcode,
        caption: p.caption || p.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        thumbnail: p.thumbnail_url || p.image?.url || p.displayUrl || p.thumbnailUrl || p.display_url || null,
        postedAt,
        likeCount: Number(p.stats?.likes ?? p.likeCount ?? p.likesCount ?? p.like_count ?? 0),
        commentCount: Number(p.stats?.comments ?? p.commentCount ?? p.commentsCount ?? p.comment_count ?? 0),
        isVideo,
      };
    })
    .filter(Boolean);
}

// POST /api/instagram/search
app.post('/api/instagram/search', async (req, res) => {
  const { username } = req.body || {};

  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: 'Instagram lookups are not configured (missing Apify token)' });
  }

  try {
    const runResp = await axios.post(
      `https://api.apify.com/v2/actors/apify~instagram-search-scraper/run-sync-get-dataset-items`,
      {
        search: username.trim(),
        searchType: 'user',
        searchLimit: 30,
        enhanceUserSearchWithFacebookPage: false,
        liveSearch: false
      },
      { params: { token: APIFY_API_TOKEN }, timeout: 60000 }
    );

    const rawItems = Array.isArray(runResp.data) ? runResp.data : [];

    const mappedChannels = rawItems.map(p => ({
      username: p.username,
      title: p.fullName || p.username,
      description: p.biography || '',
      thumbnail: p.profilePicUrlHD || p.profilePicUrl || null,
      followerCount: Number(p.followersCount || 0)
    })).filter(ch => ch.username);

    return res.json({ channels: mappedChannels });
  } catch (err) {
    const apifyStatus = err.response?.status;
    const apifyBody   = err.response?.data;
    console.error('[instagram/search] Apify error status:', apifyStatus);
    console.error('[instagram/search] Apify error body:', apifyBody ? JSON.stringify(apifyBody).slice(0, 800) : 'none');
    console.error('[instagram/search] axios message:', err.message);
    const detail = apifyBody?.error?.message || apifyBody?.message || err.message || 'Unknown error';
    return res.status(502).json({ error: `Failed to fetch search results from Instagram: ${detail}` });
  }
});

// POST /api/instagram/search-reels { topic }
app.post('/api/instagram/search-reels', async (req, res) => {
  const { topic } = req.body || {};

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: 'Topic is required' });
  }

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: 'Instagram lookups are not configured (missing Apify token)' });
  }

  const hashtag = topic.trim().replace(/^#/, '').replace(/\s+/g, '');

  try {
    const runResp = await axios.post(
      `https://api.apify.com/v2/actors/apify~instagram-hashtag-scraper/run-sync-get-dataset-items`,
      {
        hashtags: [hashtag],
        resultsLimit: 30,
      },
      { params: { token: APIFY_API_TOKEN }, timeout: 120000 }
    );

    const rawItems = Array.isArray(runResp.data) ? runResp.data : [];
    const ownerByUrl = new Map();
    rawItems.forEach((p) => {
      const url = p?.url;
      if (url) ownerByUrl.set(url, p.ownerUsername || p.owner?.username || p.username || null);
    });

    const reels = extractInstagramPosts(runResp.data)
      .filter((p) => p.isVideo)
      .map((p) => ({
        ...p,
        ownerUsername: ownerByUrl.get(p.postUrl) || null,
      }));

    return res.json({ reels });
  } catch (err) {
    const apifyStatus = err.response?.status;
    const apifyBody   = err.response?.data;
    console.error('[instagram/search-reels] Apify error status:', apifyStatus);
    console.error('[instagram/search-reels] Apify error body:', apifyBody ? JSON.stringify(apifyBody).slice(0, 800) : 'none');
    console.error('[instagram/search-reels] axios message:', err.message);
    const detail = apifyBody?.error?.message || apifyBody?.message || err.message || 'Unknown error';
    return res.status(502).json({ error: `Failed to fetch Reels from Instagram: ${detail}` });
  }
});

// GET /api/instagram/proxy-image
const imageCache = new Map();
app.get('/api/instagram/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const parsedUrl = new URL(url);
    const validHostnames = ['.cdninstagram.com', '.fbcdn.net'];
    if (!validHostnames.some(h => parsedUrl.hostname.endsWith(h))) {
      return res.status(403).json({ error: 'URL hostname not allowed' });
    }

    if (imageCache.has(url)) {
      const cached = imageCache.get(url);
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buffer);
    }

    const imgResp = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    const contentType = imgResp.headers['content-type'] || 'image/jpeg';
    const buffer = Buffer.from(imgResp.data);

    // Basic in-memory cache to prevent re-fetching the same image repeatedly
    imageCache.set(url, { buffer, contentType });
    
    // Optional: limit cache size
    if (imageCache.size > 500) {
      const firstKey = imageCache.keys().next().value;
      imageCache.delete(firstKey);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (err) {
    console.error('[instagram/proxy-image] Error proxying image:', err.message);
    return res.status(502).json({ error: 'Failed to fetch image' });
  }
});

// POST /api/instagram/recent-posts
app.post('/api/instagram/recent-posts', async (req, res) => {
  const { username, exactDate, days } = req.body || {};

  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'username is required' });
  }

  let cutoff;
  if (exactDate) {
    cutoff = new Date(exactDate);
  } else if (days) {
    const numDays = Number(days);
    if (!numDays || numDays <= 0) {
      return res.status(400).json({ error: 'days must be a positive number' });
    }
    cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - numDays);
  } else {
    return res.status(400).json({ error: 'Either exactDate or days must be provided' });
  }

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: 'Instagram lookups are not configured (missing Apify token)' });
  }

  const cutoffDateStr = cutoff.toISOString().split('T')[0];
  const cleanUsername = username.trim().replace(/^@/, '');

  try {
    console.log(`[instagram/recent-posts] calling Apify actor ${APIFY_INSTAGRAM_POSTS_ACTOR_ID} for username=${cleanUsername}`);
    const runResp = await axios.post(
      `https://api.apify.com/v2/actors/${APIFY_INSTAGRAM_POSTS_ACTOR_ID}/run-sync-get-dataset-items`,
      {
        enrich_reel_transcripts: false,
        profiles: [cleanUsername],
        results_type: 'both',
        strict_author_match: true,
        trim: false
      },
      { params: { token: APIFY_API_TOKEN }, timeout: 180000 }
    );

    const rawItems = Array.isArray(runResp.data) ? runResp.data : [];
    console.log(`[instagram/recent-posts] "until" sent to actor: ${cutoffDateStr}`);
    console.log(`[instagram/recent-posts] cutoff Date object: ${cutoff.toISOString()}`);
    console.log(`[instagram/recent-posts] raw items returned by actor: ${rawItems.length}`);
    // DEBUG: print first item's full keys and all date-candidate fields
    if (rawItems.length > 0) {
      const fi = rawItems[0];
      console.log('[instagram/recent-posts] DEBUG first item ALL keys:', JSON.stringify(Object.keys(fi)));
      const DATE_FIELDS = [
        'created_at','createdAt','timestamp','takenAt','taken_at','taken_at_timestamp',
        'pubDate','pub_date','postedAt','posted_at','date','datePosted','uploadDate'
      ];
      const dateSnapshot = {};
      DATE_FIELDS.forEach(f => { if (fi[f] !== undefined) dateSnapshot[f] = fi[f]; });
      console.log('[instagram/recent-posts] DEBUG date-related fields found:', JSON.stringify(dateSnapshot));
      console.log('[instagram/recent-posts] DEBUG first item (truncated):', JSON.stringify(fi).slice(0, 600));
    }

    const posts = extractInstagramPosts(runResp.data)
      .filter((p) => new Date(p.postedAt) >= cutoff)
      .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

    console.log(`[instagram/recent-posts] posts remaining after date filter: ${posts.length}`);

    return res.json({ posts });
  } catch (err) {
    const apifyStatus = err.response?.status;
    const apifyBody   = err.response?.data;
    console.error('[instagram/recent-posts] Apify error status:', apifyStatus);
    console.error('[instagram/recent-posts] Apify error body:', JSON.stringify(apifyBody).slice(0, 800));
    console.error('[instagram/recent-posts] axios message:', err.message);
    const detail = apifyBody?.error?.message || apifyBody?.message || err.message || 'Unknown error';
    return res.status(502).json({ error: `Failed to fetch recent posts from Instagram: ${detail}` });
  }
});

// Fetches an Instagram video/Reel transcript via the Apify transcript actor.
// Returns '' when the actor ran fine but produced no transcript; throws only
// on a genuine request failure or missing config. `timeoutMs` is caller-tunable:
// the primary route keeps a short fail-fast timeout (see comment below), while
// the watch-video job (which has no further fallback after this) uses a longer one.
async function fetchInstagramTranscriptText(postUrl, timeoutMs = 18000) {
  if (!APIFY_API_TOKEN) {
    const err = new Error('Transcript fetching is not configured (missing Apify token)');
    err.status = 500;
    throw err;
  }

  try {
    const runResp = await axios.post(
      `https://api.apify.com/v2/actors/${APIFY_INSTAGRAM_TRANSCRIPT_ACTOR_ID}/run-sync-get-dataset-items`,
      {
        includeSegments: false,
        transcriptionMethod: 'auto',
        videoUrls: [postUrl],
        whisperModel: 'base',
      },
      { params: { token: APIFY_API_TOKEN }, timeout: timeoutMs }
    );

    const rawData = runResp.data;
    console.log('[instagram-transcript] actor item count:', Array.isArray(rawData) ? rawData.length : typeof rawData);
    if (Array.isArray(rawData) && rawData.length > 0) {
      console.log('[instagram-transcript] first item keys:', JSON.stringify(Object.keys(rawData[0])));
    }

    const transcript = extractTranscriptText(rawData);
    console.log(`[instagram-transcript] transcript extracted: ${transcript ? `${transcript.length} chars` : 'NONE'}`);
    return transcript;
  } catch (err) {
    const apifyStatus = err.response?.status;
    const apifyBody   = err.response?.data;
    console.error('[instagram-transcript] Apify error status:', apifyStatus);
    console.error('[instagram-transcript] Apify error body:', apifyBody ? JSON.stringify(apifyBody).slice(0, 800) : 'none');
    console.error('[instagram-transcript] axios message:', err.message);
    const detail = apifyBody?.error?.message || apifyBody?.message || err.message || 'Unknown error';
    const publicErr = new Error(`Failed to fetch transcript: ${detail}`);
    publicErr.status = 502;
    throw publicErr;
  }
}

// POST /api/instagram/post-transcript { postUrl, isVideo }
app.post('/api/instagram/post-transcript', async (req, res) => {
  const { postUrl, isVideo } = req.body || {};

  console.log(`[instagram/post-transcript] postUrl=${postUrl} isVideo=${isVideo}`);

  if (!postUrl || typeof postUrl !== 'string') {
    return res.status(400).json({ error: 'postUrl is required' });
  }

  // Only block when isVideo is explicitly false (boolean) — not undefined/null
  if (isVideo === false) {
    console.log('[instagram/post-transcript] blocked: isVideo explicitly false (photo post)');
    return res.status(400).json({ error: 'Transcript not available — this post has no video' });
  }

  try {
    // Kept short (was 300000ms) so a stuck Apify run fails fast and the
    // frontend can fall back to /api/watch-video instead of hanging.
    const transcript = await fetchInstagramTranscriptText(postUrl, 18000);

    if (!transcript) {
      return res.status(404).json({
        error: 'Transcript not available for this post (it may be a static image, not a video/Reel)',
      });
    }

    return res.json({ postUrl, transcript });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

// Strips zero-width spaces the actor embeds in caption text and collapses
// internal newlines/whitespace to single spaces.
function cleanCaptionText(text) {
  return String(text)
    .replace(/[​‌‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extracts a plain-text transcript from various Apify actor dataset shapes:
//  - pintostudio/youtube-transcript-scraper: { data: [{start, dur, text}, ...] }
//  - sian.agency/instagram-ai-transcript-extractor: { transcriptText: string, status: string }
//  - Fallback: top-level text blob or segment arrays
function extractTranscriptText(datasetItems) {
  if (!Array.isArray(datasetItems) || datasetItems.length === 0) {
    return '';
  }

  const pieces = [];

  for (const item of datasetItems) {
    if (!item || typeof item !== 'object') continue;

    // Skip items that explicitly failed (Instagram actor sets status: 'failed')
    if (item.status && item.status !== 'succeeded') continue;

    // crawlerbros~instagram-transcript-scraper: transcript lives in `fullText`
    if (typeof item.fullText === 'string' && item.fullText.trim()) {
      pieces.push(cleanCaptionText(item.fullText));
      continue;
    }

    // Instagram AI Transcript Extractor: flat transcriptText / transcript_text string
    if (typeof item.transcriptText === 'string' && item.transcriptText.trim()) {
      pieces.push(cleanCaptionText(item.transcriptText));
      continue;
    }
    if (typeof item.transcript_text === 'string' && item.transcript_text.trim()) {
      pieces.push(cleanCaptionText(item.transcript_text));
      continue;
    }

    // crawlerbros fallback: plain string `transcript` field
    if (typeof item.transcript === 'string' && item.transcript.trim()) {
      pieces.push(cleanCaptionText(item.transcript));
      continue;
    }

    // YouTube transcript scraper: { data: [{text}, ...] } or other segment arrays
    const segments = item.data || item.captions || item.segments;
    if (Array.isArray(segments)) {
      for (const seg of segments) {
        const raw = typeof seg === 'string' ? seg : seg?.text;
        if (!raw) continue;
        const cleaned = cleanCaptionText(raw);
        if (cleaned && cleaned !== pieces[pieces.length - 1]) {
          pieces.push(cleaned);
        }
      }
      continue;
    }

    // crawlerbros segments: item.transcript may be an array of segment objects
    if (Array.isArray(item.transcript)) {
      for (const seg of item.transcript) {
        const raw = typeof seg === 'string' ? seg : (seg?.text || seg?.word);
        if (!raw) continue;
        const cleaned = cleanCaptionText(raw);
        if (cleaned && cleaned !== pieces[pieces.length - 1]) {
          pieces.push(cleaned);
        }
      }
      continue;
    }

    // Generic fallback: top-level text field
    if (typeof item.text === 'string' && item.text.trim()) {
      const cleaned = cleanCaptionText(item.text);
      if (cleaned) pieces.push(cleaned);
    }
  }

  return pieces.join(' ').trim();
}

// POST /api/instagram/post-transcript-manual { postUrl, transcript }
// Accepts a manually-pasted transcript string — bypasses Apify entirely.
app.post('/api/instagram/post-transcript-manual', (req, res) => {
  const { postUrl, transcript } = req.body || {};

  if (!postUrl || typeof postUrl !== 'string') {
    return res.status(400).json({ error: 'postUrl is required' });
  }
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }

  return res.json({ postUrl, transcript: transcript.trim() });
});

// Fetches a YouTube video's transcript via the Apify transcript actor.
// Returns '' when the actor ran fine but produced no transcript (not an
// error); throws only on a genuine request failure or missing config.
async function fetchYoutubeTranscriptText(videoId) {
  if (!APIFY_API_TOKEN || APIFY_TRANSCRIPT_ACTOR_ID === 'REPLACE_WITH_ACTOR_ID') {
    const err = new Error('Transcript fetching is not configured (missing Apify token or actor ID)');
    err.status = 500;
    throw err;
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const runResp = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_TRANSCRIPT_ACTOR_ID}/run-sync-get-dataset-items`,
      { targetLanguage: 'en', videoUrl },
      {
        params: { token: APIFY_API_TOKEN },
        timeout: 60000,
      }
    );
    return extractTranscriptText(runResp.data);
  } catch (err) {
    console.error('fetchYoutubeTranscriptText error:', err.response?.data || err.message);
    const publicErr = new Error('Failed to fetch transcript for this video');
    publicErr.status = 502;
    throw publicErr;
  }
}

// POST /api/video-transcript { videoId }
app.post('/api/video-transcript', async (req, res) => {
  const { videoId } = req.body || {};

  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'videoId is required' });
  }

  try {
    const transcript = await fetchYoutubeTranscriptText(videoId);

    if (!transcript) {
      return res.status(404).json({ error: 'Transcript not available for this video' });
    }

    return res.json({ videoId, transcript });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

function truncateForPrompt(transcript) {
  return transcript.length > 12000
    ? transcript.substring(0, 12000) + '\n...[TRUNCATED FOR LENGTH]'
    : transcript;
}

// Shared Groq call behind /api/generate-outline and the watch-video job.
// businessContext may be blank here (the watch job doesn't require one) —
// the /api/generate-outline route enforces its own "required" rule before
// calling this.
async function generateOutlineFromTranscript(transcript, businessContext) {
  if (!GROQ_API_KEY) {
    const err = new Error('Outline generation is not configured (missing Groq API key)');
    err.status = 500;
    throw err;
  }

  const truncatedTranscript = truncateForPrompt(transcript);
  const contextText = businessContext && businessContext.trim()
    ? businessContext.trim()
    : 'No specific business context provided — keep the outline generic enough to adapt to any business.';

  const prompt = `You are helping a content creator plan a new video, inspired by a reference video, but built around their own business.

Reference video transcript:
${truncatedTranscript}

Creator's business context:
${contextText}

Generate a ROUGH outline only — this is a skeleton to think from, not a script. Output ONLY the following, nothing else:

Hook:
- 2-3 short bullet points (under 8 words each), topic labels only

Demo:
- 2-3 short bullet points (under 8 words each), topic labels only

Conclusion:
- 2-3 short bullet points (under 8 words each), topic labels only

STRICT RULES — do not violate any of these:
- No markdown tables
- No timing estimates (no '45 sec', no '~2 min', etc.)
- No scripted dialogue, quoted lines, or CTA scripts
- No invented numbers, client stats, or made-up examples beyond what's in the business context or transcript
- No fake testimonials or client stories
- No production/B-roll/visual direction notes
- No suggested video title
- Total output under 80 words

Respond with ONLY a JSON object of the form {"hook": string[], "demo": string[], "conclusion": string[]}. No prose, no markdown, just the JSON object.`;

  let raw;
  try {
    const groqResp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'content-type': 'application/json',
        },
        timeout: 60000,
      }
    );
    raw = groqResp.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('generate-outline error:', err.response?.data || err.message);
    const publicErr = new Error('Failed to generate outline from Groq API');
    publicErr.status = 502;
    throw publicErr;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    console.error('generate-outline parse error:', parseErr.message, raw);
    const err = new Error('Groq returned an unparseable outline');
    err.status = 502;
    throw err;
  }

  const toBulletArray = (val) =>
    Array.isArray(val)
      ? val.map((s) => String(s).trim()).filter(Boolean)
      : [];

  const outline = {
    hook: toBulletArray(parsed?.hook),
    demo: toBulletArray(parsed?.demo),
    conclusion: toBulletArray(parsed?.conclusion),
  };

  if (!outline.hook.length && !outline.demo.length && !outline.conclusion.length) {
    const err = new Error('Groq returned an empty outline');
    err.status = 502;
    throw err;
  }

  return outline;
}

// POST /api/generate-outline { transcript, businessContext }
app.post('/api/generate-outline', async (req, res) => {
  const { transcript, businessContext } = req.body || {};

  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }
  if (!businessContext || typeof businessContext !== 'string' || !businessContext.trim()) {
    return res.status(400).json({ error: 'businessContext is required' });
  }

  try {
    const outline = await generateOutlineFromTranscript(transcript, businessContext);
    return res.json({ outline });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

// Shared Groq call behind /api/generate-assets-breakdown and the watch-video job.
async function generateAssetsBreakdownFromTranscript(transcript) {
  if (!GROQ_API_KEY) {
    const err = new Error('Assets breakdown generation is not configured (missing Groq API key)');
    err.status = 500;
    throw err;
  }

  const truncatedTranscript = truncateForPrompt(transcript);

  const prompt = `You are analyzing reference content for a creator who wants to make their own version of it.

Reference content transcript:
${truncatedTranscript}

STEP 1 — Classify what this content actually is. Ask yourself: could a viewer follow a set of steps from this content and end up with the same setup or result? Use these definitions:

- Demo: shows a capability, feature, or result WITHOUT giving a replicable process — no named steps, tools, or structure a viewer could actually copy. It shows WHAT something does, not HOW to set it up.

- Tutorial or Walkthrough: gives a CONCRETE, REPLICABLE PROCESS — a viewer could follow it step-by-step and end up with the same thing. This applies whether or not code is involved. Installing an app, creating a specific folder structure, configuring settings, or connecting a tool/integration all count as a real process, not just a demo.

- Educational: explains a concept, strategy, opinion, or idea with NO replicable setup process at all — nothing a viewer could follow step-by-step to build or configure anything.

Whether the process involves writing code is NOT what decides the category — only whether a concrete, followable process exists at all.

STEP 2 — Generate the assets breakdown based on that classification:

- Tutorial/Walkthrough involving custom code, direct API calls, or custom logic: give a step-by-step BUILD breakdown. Each step: stepName (short), description (1 sentence), difficulty (Easy/Medium/Hard).

- Tutorial/Walkthrough involving only setup/configuration (installing a tool, creating a folder structure, connecting an existing integration or MCP, entering an API key) with no custom code: give a step-by-step SETUP breakdown, same fields as above.

- Demo: no steps. State plainly that this demonstrates a tool's capability rather than teaching a process, and name the specific tool/service being shown.

- Educational: no steps. State plainly that no buildable tool or process was identified in this content.

Hard rule for all cases: only include steps, tools, or claims that are actually shown or described in the transcript. Never invent a step, tool, or process that isn't supported by the content — including for well-known tools where you might otherwise guess a typical setup. If you're not sure whether something counts as a real step or just color/commentary, leave it out.

Respond with ONLY a json object of the form:
{
  "contentType": "demo" | "tutorial" | "walkthrough" | "educational",
  "steps": [{"stepName": string, "description": string, "difficulty": "Easy" | "Medium" | "Hard"}] | null,
  "note": string | null
}
"steps" must be null for Demo or Educational content (use "note" instead). No prose, no markdown, just the json object.`;

  let raw;
  try {
    const groqResp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        max_tokens: 1536,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'content-type': 'application/json',
        },
        timeout: 60000,
      }
    );
    raw = groqResp.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('generate-assets-breakdown error:', err.response?.data || err.message);
    const publicErr = new Error('Failed to generate assets breakdown from Groq API');
    publicErr.status = 502;
    throw publicErr;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    console.error('generate-assets-breakdown parse error:', parseErr.message, raw);
    const err = new Error('Groq returned an unparseable assets breakdown');
    err.status = 502;
    throw err;
  }

  const validContentTypes = ['demo', 'tutorial', 'walkthrough', 'educational'];
  const contentType = validContentTypes.includes(parsed?.contentType) ? parsed.contentType : null;

  const steps = Array.isArray(parsed?.steps)
    ? parsed.steps
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          stepName: String(s.stepName || '').trim(),
          description: String(s.description || '').trim(),
          difficulty: ['Easy', 'Medium', 'Hard'].includes(s.difficulty) ? s.difficulty : 'Medium',
        }))
        .filter((s) => s.stepName)
    : null;

  return {
    contentType,
    steps: steps && steps.length > 0 ? steps : null,
    note: parsed?.note ? String(parsed.note).trim() : null,
  };
}

// POST /api/generate-assets-breakdown { transcript }
app.post('/api/generate-assets-breakdown', async (req, res) => {
  const { transcript } = req.body || {};

  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }

  try {
    const breakdown = await generateAssetsBreakdownFromTranscript(transcript);
    return res.json(breakdown);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Watch Video Analyzer — background jobs that fetch a transcript (YouTube via
// Apify, Instagram via Apify) and run it through the same Groq outline/assets
// prompts used by the YouTube/Instagram tabs above. Previously this shelled
// out to the Claude Code CLI's `/watch` skill (video download + frame
// analysis), which only works on a machine with Claude Code, ffmpeg, and
// yt-dlp installed — incompatible with Vercel's serverless functions
// (ephemeral filesystem, no persistent global installs, execution time
// limits). Frame/visual analysis is dropped; transcript-only analysis
// matches what the other two tabs already do, and runs anywhere this app's
// other endpoints already run, local dev included.
//
// Job state lives in Vercel KV (Redis-compatible), not process memory — a
// plain in-memory object only lives inside one serverless instance, and a
// status poll can land on a different, cold-started instance that never saw
// the job get created, which is exactly what produced "Job not found" in
// production. Same reasoning applies to the single-job-at-a-time lock below.
// ---------------------------------------------------------------------------

// @vercel/kv is deprecated (Vercel KV was retired in favor of Marketplace
// Redis integrations); @upstash/redis is the actively-maintained client it
// used to wrap internally, with the same get/set/del + nx/ex option shape.
//
// Built manually (not Redis.fromEnv()) so we can defend against a value
// pasted into a dashboard env var UI with literal wrapping quote characters
// still attached (dotenv strips these when loading a .env file locally, but
// a value typed straight into Vercel's env var UI keeps them verbatim,
// producing a URL/token string that looks plausible in the dashboard but
// fails to connect).
const { Redis } = require('@upstash/redis');

function cleanEnvValue(val) {
  if (typeof val !== 'string') return val;
  return val.trim().replace(/^['"]|['"]$/g, '');
}

const redisUrl = cleanEnvValue(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
const redisToken = cleanEnvValue(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);

// Never log the actual values — only whether they're present/well-formed —
// so this is safe to leave in place in production logs.
console.log(
  '[watch-video] Redis config check: url=%s (%s), token=%s (len=%d)',
  redisUrl ? 'present' : 'MISSING',
  redisUrl ? (/^https:\/\//.test(redisUrl) ? 'looks like a valid https URL' : `UNEXPECTED FORMAT: starts with "${redisUrl.slice(0, 12)}..."`) : 'n/a',
  redisToken ? 'present' : 'MISSING',
  redisToken ? redisToken.length : 0
);

const redis = new Redis({ url: redisUrl, token: redisToken });

const WATCH_JOB_KEY_PREFIX = 'watch-job:';
const WATCH_JOB_TTL_SECONDS = 15 * 60; // how long a finished job's result stays fetchable
const WATCH_JOB_LOCK_KEY = 'watch-job-lock';
const WATCH_JOB_LOCK_TTL_SECONDS = 10 * 60; // safety net: auto-clears if a job crashes without releasing the lock

function watchJobKey(jobId) {
  return `${WATCH_JOB_KEY_PREFIX}${jobId}`;
}

// Logs everything useful about a Redis failure — message, stack, and any
// extra fields the Upstash client attaches (e.g. HTTP status/body) — instead
// of the single err.message string that was previously all that reached the
// logs, which wasn't enough to tell "bad credentials" apart from "network
// error" apart from "malformed URL".
function logRedisError(context, err) {
  console.error(`[watch-video] Redis error in ${context}:`, {
    message: err?.message,
    name: err?.name,
    stack: err?.stack,
    ...(err && typeof err === 'object' ? err : {}),
  });
}

async function getWatchJob(jobId) {
  return redis.get(watchJobKey(jobId));
}

async function setWatchJob(jobId, data) {
  await redis.set(watchJobKey(jobId), data, { ex: WATCH_JOB_TTL_SECONDS });
}

// Atomic across instances: set with nx only succeeds if the key doesn't
// already exist, so two concurrent requests (even on different cold-started
// instances) can't both "win" the lock the way the old in-memory boolean could.
async function acquireWatchJobLock() {
  const result = await redis.set(WATCH_JOB_LOCK_KEY, '1', { nx: true, ex: WATCH_JOB_LOCK_TTL_SECONDS });
  return result === 'OK' || result === true;
}

async function releaseWatchJobLock() {
  await redis.del(WATCH_JOB_LOCK_KEY);
}

// Identifies the platform + id/url the transcript fetchers need from a
// pasted video URL. Returns null for anything unrecognized.
function parseVideoSource(rawUrl) {
  const url = String(rawUrl || '').trim();

  const ytMatch = url.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/
  );
  if (ytMatch) {
    return { platform: 'youtube', videoId: ytMatch[1] };
  }

  if (/instagram\.com\/(?:reel|p|tv)\//.test(url)) {
    return { platform: 'instagram', postUrl: url };
  }

  return null;
}

async function runWatchVideoJob(jobId, url, businessContext) {
  try {
    const source = parseVideoSource(url);
    if (!source) {
      const err = new Error('Unsupported URL — paste a YouTube or Instagram video/Reel link.');
      err.status = 400;
      throw err;
    }

    const transcript = source.platform === 'youtube'
      ? await fetchYoutubeTranscriptText(source.videoId)
      : await fetchInstagramTranscriptText(source.postUrl, 60000);

    if (!transcript || !transcript.trim()) {
      throw new Error('Transcript not available for this video');
    }
    const trimmedTranscript = transcript.trim();

    // Outline/assets are a bonus on top of the transcript, not a hard
    // requirement — degrade to null on failure (e.g. Groq misconfigured)
    // rather than failing the whole job, same leniency the CLI path had.
    let outline = null;
    try {
      outline = await generateOutlineFromTranscript(trimmedTranscript, businessContext);
    } catch (err) {
      console.error('watch-video outline generation failed:', err.message);
    }

    let assetsBreakdown = null;
    try {
      assetsBreakdown = await generateAssetsBreakdownFromTranscript(trimmedTranscript);
    } catch (err) {
      console.error('watch-video assets breakdown generation failed:', err.message);
    }

    await setWatchJob(jobId, {
      status: 'done',
      result: { transcript: trimmedTranscript, outline, assetsBreakdown },
      finishedAt: Date.now(),
    });
  } catch (err) {
    console.error('watch-video job error:', err.message);
    try {
      await setWatchJob(jobId, { status: 'failed', error: err.message || 'Watch job failed', finishedAt: Date.now() });
    } catch (writeErr) {
      logRedisError('setWatchJob failure write (runWatchVideoJob)', writeErr);
    }
  } finally {
    try {
      await releaseWatchJobLock();
    } catch (lockErr) {
      logRedisError('releaseWatchJobLock (runWatchVideoJob)', lockErr);
    }
  }
}

// POST /api/watch-video { url, businessContext? }
// Starts a background /watch skill run and returns immediately with a jobId.
app.post('/api/watch-video', async (req, res) => {
  const { url, businessContext } = req.body || {};

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'url is required' });
  }

  let gotLock;
  try {
    gotLock = await acquireWatchJobLock();
  } catch (err) {
    logRedisError('acquireWatchJobLock (POST /api/watch-video)', err);
    return res.status(500).json({ error: 'Job storage is unavailable (KV connection failed)' });
  }

  if (!gotLock) {
    return res.status(429).json({ error: 'A watch job is already running — please wait for it to finish.' });
  }

  const jobId = crypto.randomUUID();
  try {
    await setWatchJob(jobId, { status: 'processing' });
  } catch (err) {
    logRedisError('setWatchJob initial write (POST /api/watch-video)', err);
    await releaseWatchJobLock();
    return res.status(500).json({ error: 'Job storage is unavailable (KV connection failed)' });
  }

  // Fire and forget — runWatchVideoJob handles its own errors internally.
  runWatchVideoJob(jobId, url.trim(), businessContext);

  return res.json({ jobId });
});

// GET /api/watch-status/:jobId
app.get('/api/watch-status/:jobId', async (req, res) => {
  let job;
  try {
    job = await getWatchJob(req.params.jobId);
  } catch (err) {
    logRedisError('getWatchJob (GET /api/watch-status)', err);
    return res.status(500).json({ error: 'Job storage is unavailable (KV connection failed)' });
  }
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

const PORT = process.env.PORT || 5000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
