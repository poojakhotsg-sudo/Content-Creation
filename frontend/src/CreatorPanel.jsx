import React, { useState } from 'react';

const TIMEFRAME_OPTIONS = [
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '4 weeks', days: 28 },
];

const DURATION_OPTIONS = [
  { label: 'All videos', value: 'all' },
  { label: 'Under 5 minutes', value: 'under5' },
  { label: 'Over 5 minutes', value: 'over5' },
];

// Generic creator-search -> recent-items flow shared by the YouTube and
// Instagram tabs. Platform-specific request/response shapes are supplied
// via props rather than hardcoded here.
export default function CreatorPanel({
  creatorPlaceholder,
  searchUrl,
  itemsUrl,
  itemsResponseKey,
  showDurationFilter,
  buildSearchBody,
  buildItemsBody,
  normalizeProfile,
  normalizeItem,
  emptyMessage,
  renderDetail,
  showExactDateFilter,
}) {
  const [creatorName, setCreatorName] = useState('');
  const [days, setDays] = useState(14);
  const [durationFilter, setDurationFilter] = useState('all');
  const [exactDate, setExactDate] = useState(new Date().toISOString().split('T')[0]);
  const [filterType, setFilterType] = useState('weeks'); // 'weeks' or 'date'

  const [profile, setProfile] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [items, setItems] = useState([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [itemsCache, setItemsCache] = useState({});

  const [searchLoading, setSearchLoading] = useState(false);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedItem, setSelectedItem] = useState(null);

  const isLoading = searchLoading || itemsLoading;

  async function handleFetch(e) {
    if (e) e.preventDefault();
    setError('');
    setProfile(null);
    setSearchResults(null);
    setItems([]);
    setHasSearched(false);

    const name = creatorName.trim();
    if (!name) {
      setError('Please enter a creator name.');
      return;
    }

    if (searchUrl) {
      setSearchLoading(true);
      try {
        const resp = await fetch(searchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildSearchBody(name)),
        });
        const data = await resp.json();
        if (!resp.ok) {
          throw new Error(data.error || 'Failed to find creator');
        }
        
        if (data.channels && Array.isArray(data.channels)) {
          setSearchResults(data.channels);
          setHasSearched(true);
          setSearchLoading(false);
          return; // Stop here, wait for user to select a channel
        } else {
          // Fallback for single profile (e.g. if Instagram ever uses searchUrl)
          const resolvedProfile = data;
          setProfile(resolvedProfile);
          await fetchItems(resolvedProfile);
        }
      } catch (err) {
        setError(err.message || 'Failed to search for creator');
        setSearchLoading(false);
        return;
      }
      setSearchLoading(false);
    } else {
      const resolvedProfile = buildSearchBody(name);
      setProfile(resolvedProfile);
      setHasSearched(true);
      await fetchItems(resolvedProfile);
    }
  }

  async function fetchItems(resolvedProfile) {
    setItemsLoading(true);
    setItems([]);
    
    const bodyObj = buildItemsBody(resolvedProfile, days, durationFilter, exactDate, filterType);
    const cacheKey = JSON.stringify(bodyObj);

    if (itemsCache[cacheKey]) {
      setItems(itemsCache[cacheKey]);
      setItemsLoading(false);
      return;
    }

    try {
      const resp = await fetch(itemsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to fetch recent items');
      }
      const newItems = data[itemsResponseKey] || [];
      setItems(newItems);
      setItemsCache(prev => ({ ...prev, [cacheKey]: newItems }));
    } catch (err) {
      setError(err.message || 'Failed to fetch recent items');
    } finally {
      setItemsLoading(false);
    }
  }

  function handleSelectChannel(channel) {
    setProfile(channel);
    fetchItems(channel);
  }

  function handleBackToResults() {
    setProfile(null);
    setItems([]);
  }

  if (selectedItem) {
    return renderDetail(selectedItem, () => setSelectedItem(null));
  }

  const normalizedProfile = profile && normalizeProfile ? normalizeProfile(profile) : null;

  return (
    <div>
      <form className="search-form" onSubmit={handleFetch}>
        <input
          type="text"
          placeholder={creatorPlaceholder}
          value={creatorName}
          onChange={(e) => setCreatorName(e.target.value)}
          disabled={isLoading}
        />
        {!showExactDateFilter ? (
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={isLoading}
          >
            {TIMEFRAME_OPTIONS.map((opt) => (
              <option key={opt.days} value={opt.days}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              disabled={isLoading}
            >
              <option value="weeks">Weeks</option>
              <option value="date">Exact Date</option>
            </select>
            {filterType === 'weeks' ? (
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                disabled={isLoading}
              >
                {TIMEFRAME_OPTIONS.map((opt) => (
                  <option key={opt.days} value={opt.days}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="date"
                value={exactDate}
                onChange={(e) => setExactDate(e.target.value)}
                disabled={isLoading}
              />
            )}
          </>
        )}
        {showDurationFilter && (
          <select
            value={durationFilter}
            onChange={(e) => setDurationFilter(e.target.value)}
            disabled={isLoading}
          >
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
        <button type="submit" disabled={isLoading}>
          {isLoading ? 'Fetching…' : 'Fetch'}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {searchLoading && <div className="status">Searching for creator…</div>}

      {/* Selected Profile View */}
      {normalizedProfile && (
        <div className="channel-card-header">
          {searchResults && (
            <button className="back-button" onClick={handleBackToResults} disabled={itemsLoading} style={{ marginTop: '-10px', marginBottom: '10px' }}>
              &larr; Back to results
            </button>
          )}
          <div className="channel-card">
            {normalizedProfile.thumbnail && (
              <img src={normalizedProfile.thumbnail} alt={normalizedProfile.title} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%23ccc"/><text x="50" y="55" font-family="sans-serif" font-size="30" text-anchor="middle" fill="%23666">?</text></svg>'; }} />
            )}
            <div>
              <div className="channel-title">{normalizedProfile.title}</div>
              <div className="channel-subs">{normalizedProfile.subtitle}</div>
              {normalizedProfile.description && (
                <div className="channel-desc">{normalizedProfile.description}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Search Results View */}
      {!profile && searchResults && searchResults.length > 0 && (
        <div className="search-results-grid">
          {searchResults.map((ch) => {
            const norm = normalizeProfile(ch);
            return (
              <div key={ch.channelId || norm.title} className="channel-card clickable" onClick={() => handleSelectChannel(ch)}>
                {norm.thumbnail && (
                  <img src={norm.thumbnail} alt={norm.title} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%23ccc"/><text x="50" y="55" font-family="sans-serif" font-size="30" text-anchor="middle" fill="%23666">?</text></svg>'; }} />
                )}
                <div>
                  <div className="channel-title">{norm.title}</div>
                  <div className="channel-subs">{norm.subtitle}</div>
                  {norm.description && <div className="channel-desc">{norm.description}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {itemsLoading && <div className="status">Loading recent {itemsResponseKey}…</div>}

      {!itemsLoading && hasSearched && !profile && searchResults && searchResults.length === 0 && !error && (
        <div className="status">No matching channels found.</div>
      )}

      {!itemsLoading && hasSearched && profile && items.length === 0 && !error && (
        <div className="status">{emptyMessage}</div>
      )}

      {items.length > 0 && (
        <div className="video-grid">
          {items.map((raw) => {
            const item = normalizeItem(raw);
            return (
              <div key={item.key} className="video-card">
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.thumbnail && <img src={item.thumbnail} alt={item.title} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%23ccc"/><text x="50" y="55" font-family="sans-serif" font-size="30" text-anchor="middle" fill="%23666">?</text></svg>'; }} />}
                  <div className="video-info">
                    {item.badge && <span className="item-badge">{item.badge}</span>}
                    <div className="video-title">{item.title}</div>
                    <div className="video-meta">{item.meta}</div>
                  </div>
                </a>
                <button className="use-idea-button" onClick={() => setSelectedItem(raw)}>
                  Use this idea
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
