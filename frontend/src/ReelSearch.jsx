import React, { useState } from "react";
import TranscriptDetail from "./TranscriptDetail.jsx";

function timeSince(iso) {
  if (!iso) return "";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, s] of units) {
    const v = Math.floor(seconds / s);
    if (v >= 1) return `${v} ${name}${v > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

function fmt(n) {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(Number(n) || 0);
}

function truncate(text, max = 80) {
  if (!text) return "(no caption)";
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

export default function ReelSearch() {
  const [topic, setTopic] = useState("");
  const [reels, setReels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedReel, setSelectedReel] = useState(null);

  async function handleSearch(e) {
    e.preventDefault();
    const q = topic.trim();
    if (!q) { setError("Please enter a topic or keyword."); return; }

    setError("");
    setReels([]);
    setHasSearched(false);
    setLoading(true);

    try {
      const resp = await fetch("/api/instagram/search-reels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: q }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Search failed");
      setReels(data.reels || []);
      setHasSearched(true);
    } catch (err) {
      setError(err.message || "Failed to search reels");
    } finally {
      setLoading(false);
    }
  }

  if (selectedReel) {
    return (
      <TranscriptDetail
        item={{
          url: selectedReel.postUrl,
          thumbnail: selectedReel.thumbnail,
          title: truncate(selectedReel.caption),
        }}
        onBack={() => setSelectedReel(null)}
        transcriptUrl="/api/instagram/post-transcript"
        transcriptBody={{ postUrl: selectedReel.postUrl, isVideo: true }}
        referenceLabel="Original Reel (for reference)"
        referenceNote="This is inspiration only — use it to understand the angle and structure, not to copy it."
        noTranscriptHint="Go back and pick a different Reel to try again."
      />
    );
  }

  return (
    <div>
      <form className="search-form" onSubmit={handleSearch}>
        <input
          type="text"
          placeholder="Topic or niche (e.g. personal finance, AI tools, fitness)"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search Reels"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}
      {loading && <div className="status">Searching Instagram Reels for &ldquo;{topic}&rdquo;&hellip;</div>}

      {!loading && hasSearched && reels.length === 0 && !error && (
        <div className="status">No Reels found for this topic — try a broader keyword.</div>
      )}

      {reels.length > 0 && (
        <>
          <p className="reel-search-count">{reels.length} Reel{reels.length !== 1 ? "s" : ""} found</p>
          <div className="video-grid">
            {reels.map((reel) => (
              <div key={reel.postUrl} className="video-card">
                <a href={reel.postUrl} target="_blank" rel="noreferrer">
                  {reel.thumbnail && <img src={reel.thumbnail} alt={truncate(reel.caption)} />}
                  <div className="video-info">
                    <span className="item-badge">Reel</span>
                    <div className="video-title">{truncate(reel.caption)}</div>
                    <div className="video-meta">
                      {fmt(reel.likeCount)} likes &middot; {fmt(reel.commentCount)} comments
                      {reel.postedAt ? ` · ${timeSince(reel.postedAt)}` : ""}
                      {reel.ownerUsername ? ` · @${reel.ownerUsername}` : ""}
                    </div>
                  </div>
                </a>
                <button className="use-idea-button" onClick={() => setSelectedReel(reel)}>
                  Use this idea
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
