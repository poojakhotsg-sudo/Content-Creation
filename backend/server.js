require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { execFile } = require('child_process');

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

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: 'Transcript fetching is not configured (missing Apify token)' });
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
      // Kept short (was 300000ms) so a stuck Apify run fails fast and the
      // frontend can fall back to /api/watch-video instead of hanging.
      { params: { token: APIFY_API_TOKEN }, timeout: 18000 }
    );

    const rawData = runResp.data;
    console.log('[instagram/post-transcript] actor item count:', Array.isArray(rawData) ? rawData.length : typeof rawData);
    if (Array.isArray(rawData) && rawData.length > 0) {
      console.log('[instagram/post-transcript] first item keys:', JSON.stringify(Object.keys(rawData[0])));
      console.log('[instagram/post-transcript] first item (truncated):', JSON.stringify(rawData[0]).slice(0, 600));
    }

    const transcript = extractTranscriptText(rawData);
    console.log(`[instagram/post-transcript] transcript extracted: ${transcript ? `${transcript.length} chars` : 'NONE'}`);

    if (!transcript) {
      return res.status(404).json({
        error: 'Transcript not available for this post (it may be a static image, not a video/Reel)',
      });
    }

    return res.json({ postUrl, transcript });
  } catch (err) {
    const apifyStatus = err.response?.status;
    const apifyBody   = err.response?.data;
    console.error('[instagram/post-transcript] Apify error status:', apifyStatus);
    console.error('[instagram/post-transcript] Apify error body:', apifyBody ? JSON.stringify(apifyBody).slice(0, 800) : 'none');
    console.error('[instagram/post-transcript] axios message:', err.message);
    const detail = apifyBody?.error?.message || apifyBody?.message || err.message || 'Unknown error';
    return res.status(502).json({ error: `Failed to fetch transcript: ${detail}` });
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

// POST /api/video-transcript { videoId }
app.post('/api/video-transcript', async (req, res) => {
  const { videoId } = req.body || {};

  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'videoId is required' });
  }

  if (!APIFY_API_TOKEN || APIFY_TRANSCRIPT_ACTOR_ID === 'REPLACE_WITH_ACTOR_ID') {
    return res.status(500).json({
      error: 'Transcript fetching is not configured (missing Apify token or actor ID)',
    });
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

    const transcript = extractTranscriptText(runResp.data);

    if (!transcript) {
      return res.status(404).json({ error: 'Transcript not available for this video' });
    }

    return res.json({ videoId, transcript });
  } catch (err) {
    console.error('video-transcript error:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Failed to fetch transcript for this video' });
  }
});

// POST /api/generate-outline { transcript, businessContext }
app.post('/api/generate-outline', async (req, res) => {
  const { transcript, businessContext } = req.body || {};

  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }
  if (!businessContext || typeof businessContext !== 'string' || !businessContext.trim()) {
    return res.status(400).json({ error: 'businessContext is required' });
  }

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'Outline generation is not configured (missing Groq API key)' });
  }

  const truncatedTranscript = transcript.length > 12000 ? transcript.substring(0, 12000) + '\n...[TRUNCATED FOR LENGTH]' : transcript;

  const prompt = `You are helping a content creator plan a new video, inspired by a reference video, but built around their own business.

Reference video transcript:
${truncatedTranscript}

Creator's business context:
${businessContext}

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

    const raw = groqResp.data?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('generate-outline parse error:', parseErr.message, raw);
      return res.status(502).json({ error: 'Groq returned an unparseable outline' });
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
      return res.status(502).json({ error: 'Groq returned an empty outline' });
    }

    return res.json({ outline });
  } catch (err) {
    console.error('generate-outline error:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Failed to generate outline from Groq API' });
  }
});

// POST /api/generate-assets-breakdown { transcript }
app.post('/api/generate-assets-breakdown', async (req, res) => {
  const { transcript } = req.body || {};

  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'Assets breakdown generation is not configured (missing Groq API key)' });
  }

  const truncatedTranscript = transcript.length > 12000 ? transcript.substring(0, 12000) + '\n...[TRUNCATED FOR LENGTH]' : transcript;

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

    const raw = groqResp.data?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('generate-assets-breakdown parse error:', parseErr.message, raw);
      return res.status(502).json({ error: 'Groq returned an unparseable assets breakdown' });
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

    return res.json({
      contentType,
      steps: steps && steps.length > 0 ? steps : null,
      note: parsed?.note ? String(parsed.note).trim() : null,
    });
  } catch (err) {
    console.error('generate-assets-breakdown error:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Failed to generate assets breakdown from Groq API' });
  }
});

// ---------------------------------------------------------------------------
// Watch Video Analyzer — background jobs powered by the Claude Code `/watch`
// skill (bradautomates/claude-video), run headlessly via `claude -p`.
// Purely additive: does not touch the YouTube/Instagram fetch → outline →
// assets flow above. In-memory only (no DB) — jobs are lost on restart.
// ---------------------------------------------------------------------------

const watchJobs = {}; // jobId -> { status: 'processing' | 'done' | 'failed', result?, error? }
let watchJobInProgress = false; // simple single-job-at-a-time guard, no queue yet

const WATCH_JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for the `claude -p` call

function buildWatchPrompt(url, businessContext) {
  return `This is a background job for our own Creator Research app (a Node/Express + React tool for analyzing reference videos). Please use the /watch skill to watch this video and analyze it: ${url}

The analysis is for a creator on our team who wants to make their own version of this content${
    businessContext && businessContext.trim() ? `, for this business: ${businessContext.trim()}` : ''
  }.

Once you've watched it (transcript + frame analysis), write your findings back as a single JSON object of this exact shape, and nothing else — no prose, no markdown fencing, just the JSON object itself as your final message:
{
  "transcript": string,
  "outline": { "hook": string[], "demo": string[], "conclusion": string[] },
  "assetsBreakdown": {
    "contentType": "demo" | "tutorial" | "walkthrough" | "educational",
    "steps": [{"stepName": string, "description": string, "difficulty": "Easy" | "Medium" | "Hard"}] | null,
    "note": string | null
  }
}
Only include steps/tools that are actually shown or described in the video — never invent one. "steps" must be null for demo or educational content (use "note" instead).`;
}

function runClaudeHeadless(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      [
        '-p', prompt,
        // The /watch skill needs to run ffmpeg/yt-dlp and fetch the video
        // unattended — there's no one around to answer permission prompts
        // in a background job, so we pre-authorize tool use here. Requires
        // the /watch skill's one-time interactive setup (installing
        // ffmpeg/yt-dlp, API keys) to have already been done on this machine.
        '--dangerously-skip-permissions',
      ],
      { timeout: WATCH_JOB_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(stderr?.trim() || err.message || 'claude -p failed'));
        }
        resolve(stdout);
      }
    );
  });
}

function extractJsonObject(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in Claude output');
  return JSON.parse(match[0]);
}

async function runWatchVideoJob(jobId, url, businessContext) {
  try {
    const prompt = buildWatchPrompt(url, businessContext);
    const stdout = await runClaudeHeadless(prompt);
    const parsed = extractJsonObject(stdout);

    if (!parsed || typeof parsed.transcript !== 'string' || !parsed.transcript.trim()) {
      throw new Error('Claude output did not include a transcript');
    }

    watchJobs[jobId] = {
      status: 'done',
      result: {
        transcript: parsed.transcript.trim(),
        outline: parsed.outline || null,
        assetsBreakdown: parsed.assetsBreakdown || null,
      },
    };
  } catch (err) {
    console.error('watch-video job error:', err.message);
    watchJobs[jobId] = { status: 'failed', error: err.message || 'Watch job failed' };
  } finally {
    watchJobInProgress = false;
  }
}

// POST /api/watch-video { url, businessContext? }
// Starts a background /watch skill run and returns immediately with a jobId.
app.post('/api/watch-video', (req, res) => {
  const { url, businessContext } = req.body || {};

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'url is required' });
  }

  if (watchJobInProgress) {
    return res.status(429).json({ error: 'A watch job is already running — please wait for it to finish.' });
  }

  const jobId = crypto.randomUUID();
  watchJobs[jobId] = { status: 'processing' };
  watchJobInProgress = true;

  // Fire and forget — runWatchVideoJob handles its own errors internally.
  runWatchVideoJob(jobId, url.trim(), businessContext);

  return res.json({ jobId });
});

// GET /api/watch-status/:jobId
app.get('/api/watch-status/:jobId', (req, res) => {
  const job = watchJobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
