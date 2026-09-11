import React, { useState } from 'react';
import CreatorPanel from './CreatorPanel.jsx';
import TranscriptDetail from './TranscriptDetail.jsx';

function timeSince(publishedAt) {
  const seconds = Math.floor((Date.now() - new Date(publishedAt).getTime()) / 1000);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [name, secondsInUnit] of units) {
    const value = Math.floor(seconds / secondsInUnit);
    if (value >= 1) return `${value} ${name}${value > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function formatViews(count) {
  return new Intl.NumberFormat('en-US', { notation: 'compact' }).format(count);
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function truncateCaption(text, maxLength = 80) {
  if (!text) return '(no caption)';
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}…` : text;
}

const YOUTUBE_CONFIG = {
  creatorPlaceholder: 'Creator name (exact channel title)',
  searchUrl: '/api/creator-search',
  itemsUrl: '/api/recent-videos',
  itemsResponseKey: 'videos',
  showDurationFilter: true,
  buildSearchBody: (name) => ({ creatorName: name }),
  buildItemsBody: (profile, days, durationFilter) => ({
    channelId: profile.channelId,
    days,
    durationFilter,
  }),
  normalizeProfile: (data) => ({
    title: data.title,
    subtitle: `${formatViews(data.subscriberCount)} subscribers`,
    thumbnail: data.thumbnail,
  }),
  normalizeItem: (v) => ({
    key: v.videoId,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    thumbnail: v.thumbnail,
    title: v.title,
    meta: `${formatViews(v.viewCount)} views · ${timeSince(v.publishedAt)} · ${formatDuration(
      v.durationSeconds
    )}`,
  }),
  emptyMessage: 'No uploads match this timeframe and duration filter — try widening either one.',
  renderDetail: (video, onBack) => (
    <TranscriptDetail
      item={{
        url: `https://www.youtube.com/watch?v=${video.videoId}`,
        thumbnail: video.thumbnail,
        title: video.title,
      }}
      onBack={onBack}
      transcriptUrl="/api/video-transcript"
      transcriptBody={{ videoId: video.videoId }}
      referenceLabel="Original video (for reference)"
      referenceNote="This is inspiration only — use it to understand the angle and structure, not to copy it."
      noTranscriptHint="Go back and pick a different video to try again."
    />
  ),
};

const INSTAGRAM_CONFIG = {
  creatorPlaceholder: 'Instagram username',
  itemsUrl: '/api/instagram/recent-posts',
  itemsResponseKey: 'posts',
  showDurationFilter: false,
  showExactDateFilter: true,
  buildSearchBody: (name) => ({ username: name.replace(/^@/, '') }),
  buildItemsBody: (profile, days, durationFilter, exactDate, filterType) => ({
    username: profile.username,
    days: filterType === 'weeks' ? days : undefined,
    exactDate: filterType === 'date' ? exactDate : undefined,
  }),
  normalizeItem: (p) => ({
    key: p.postUrl,
    url: p.postUrl,
    thumbnail: p.thumbnail,
    title: truncateCaption(p.caption),
    badge: p.isVideo ? 'Reel' : 'Photo',
    meta: `${formatViews(p.likeCount)} likes · ${formatViews(p.commentCount)} comments · ${timeSince(
      p.postedAt
    )}`,
  }),
  emptyMessage: 'No posts match this timeframe — try widening it.',
  renderDetail: (post, onBack) => (
    <TranscriptDetail
      item={{
        url: post.postUrl,
        thumbnail: post.thumbnail,
        title: truncateCaption(post.caption),
      }}
      onBack={onBack}
      transcriptUrl="/api/instagram/post-transcript"
      transcriptBody={{ postUrl: post.postUrl, isVideo: post.isVideo }}
      referenceLabel="Original post (for reference)"
      referenceNote="This is inspiration only — use it to understand the angle and structure, not to copy it."
      noTranscriptHint="Go back and pick a different post to try again."
      skipTranscript={!post.isVideo}
      skipMessage="This is a photo post — no transcript available. Use the caption above as reference."
    />
  ),
};

const TABS = [
  { key: 'youtube', label: 'YouTube', heading: 'YouTube Creator Research', config: YOUTUBE_CONFIG },
  { key: 'instagram', label: 'Instagram', heading: 'Instagram Creator Research', config: INSTAGRAM_CONFIG },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('youtube');
  const tab = TABS.find((t) => t.key === activeTab);

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <h1 className="app-title">Creator Research</h1>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`sidebar-tab ${t.key === activeTab ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </aside>
      <main className="page">
        <h2 className="tab-heading">{tab.heading}</h2>
        <CreatorPanel key={tab.key} {...tab.config} />
      </main>
    </div>
  );
}
