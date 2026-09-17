import React, { useEffect, useRef, useState } from 'react';

export default function TranscriptDetail({
  item,
  onBack,
  transcriptUrl,
  transcriptBody,
  referenceLabel,
  referenceNote,
  noTranscriptHint,
  skipTranscript = false,
  skipMessage,
  enableWatchFallback = false,
}) {
  const [transcript, setTranscript] = useState('');
  const [loading, setLoading] = useState(!skipTranscript);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  // Automatic /watch skill fallback when the primary fetch fails/times out
  // (Instagram only — see enableWatchFallback). Reuses `error` for its own
  // failure so the existing manual-paste fallback UI still applies.
  const [fallbackActive, setFallbackActive] = useState(false);
  const fallbackPollRef = useRef(null);

  // Manual transcript paste fallback (shown when auto-fetch fails)
  const [manualText, setManualText] = useState('');
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState('');

  const [businessContext, setBusinessContext] = useState(
    () => localStorage.getItem('businessContext') || ''
  );
  const [outline, setOutline] = useState(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState('');

  const [assetSteps, setAssetSteps] = useState(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState('');
  const [contentType, setContentType] = useState(null);
  const [assetNote, setAssetNote] = useState(null);

  // 'outline' | 'assets'
  const [activeResultTab, setActiveResultTab] = useState('outline');

  const transcriptBodyJson = JSON.stringify(transcriptBody);

  function handleBusinessContextBlur() {
    localStorage.setItem('businessContext', businessContext);
  }

  async function handleGenerateOutline() {
    setOutlineLoading(true);
    setOutlineError('');
    setOutline(null);
    setActiveResultTab('outline');
    try {
      const resp = await fetch('/api/generate-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, businessContext }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to generate outline');
      setOutline(data.outline);
    } catch (err) {
      setOutlineError(err.message || 'Failed to generate outline');
    } finally {
      setOutlineLoading(false);
    }
  }

  async function handleGenerateAssetsBreakdown() {
    setAssetsLoading(true);
    setAssetsError('');
    setAssetSteps(null);
    setContentType(null);
    setAssetNote(null);
    setActiveResultTab('assets');
    try {
      const resp = await fetch('/api/generate-assets-breakdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to generate assets breakdown');
      setAssetSteps(data.steps || null);
      setContentType(data.contentType || null);
      setAssetNote(data.note || null);
    } catch (err) {
      setAssetsError(err.message || 'Failed to generate assets breakdown');
    } finally {
      setAssetsLoading(false);
    }
  }

  function handleGenerateBoth() {
    handleGenerateOutline();
    handleGenerateAssetsBreakdown();
  }

  function stopFallbackPolling() {
    if (fallbackPollRef.current) {
      clearInterval(fallbackPollRef.current);
      fallbackPollRef.current = null;
    }
  }

  async function pollFallbackStatus(jobId, cancelledRef) {
    try {
      const resp = await fetch(`/api/watch-status/${jobId}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Backup method failed');

      if (data.status === 'done') {
        stopFallbackPolling();
        if (cancelledRef.current) return;
        setFallbackActive(false);
        setTranscript(data.result.transcript);
        setError('');
      } else if (data.status === 'failed') {
        stopFallbackPolling();
        if (cancelledRef.current) return;
        setFallbackActive(false);
        setError(data.error || 'Backup method failed');
      }
      // else still processing — keep polling
    } catch (err) {
      stopFallbackPolling();
      if (cancelledRef.current) return;
      setFallbackActive(false);
      setError(err.message || 'Backup method failed');
    }
  }

  async function startWatchFallback(videoUrl, cancelledRef) {
    setFallbackActive(true);
    try {
      const resp = await fetch('/api/watch-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: videoUrl }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to start backup watch job');
      if (cancelledRef.current) return;
      fallbackPollRef.current = setInterval(() => pollFallbackStatus(data.jobId, cancelledRef), 4000);
    } catch (err) {
      if (cancelledRef.current) return;
      setFallbackActive(false);
      setError(err.message || 'Backup method failed');
    }
  }

  useEffect(() => {
    if (skipTranscript) return;
    let cancelled = false;
    const cancelledRef = { current: false };
    async function fetchTranscript() {
      setLoading(true);
      setError('');
      setTranscript('');
      try {
        const resp = await fetch(transcriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: transcriptBodyJson,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed to fetch transcript');
        if (!cancelled) setTranscript(data.transcript);
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Failed to fetch transcript');
        if (enableWatchFallback) {
          startWatchFallback(item.url, cancelledRef);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchTranscript();
    return () => {
      cancelled = true;
      cancelledRef.current = true;
      stopFallbackPolling();
    };
  }, [skipTranscript, transcriptUrl, transcriptBodyJson]);

  return (
    <div className="video-detail">
      <button className="back-button" onClick={onBack}>
        ← Back to results
      </button>

      <h2 className="section-label">{referenceLabel}</h2>
      <p className="reference-note">{referenceNote}</p>

      <a className="original-video-card" href={item.url} target="_blank" rel="noreferrer">
        {item.thumbnail && <img src={item.thumbnail} alt={item.title} />}
        <div className="original-video-title">{item.title}</div>
      </a>

      {skipTranscript ? (
        <div className="status">{skipMessage}</div>
      ) : (
        <>
          <h3 className="section-label">Transcript</h3>
          {loading && <div className="status">Fetching transcript…</div>}
          {fallbackActive && <div className="status">Trying backup method…</div>}
          {error && !fallbackActive && (
            <div className="error">
              {error}
              <div className="error-hint">{noTranscriptHint}</div>
              <div className="manual-transcript-fallback">
                <p className="manual-transcript-label">
                  Or paste the transcript manually to continue:
                </p>
                <textarea
                  className="business-context-input"
                  rows={5}
                  placeholder="Paste the transcript text here…"
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                />
                {manualError && <div className="error" style={{ marginTop: '0.5rem' }}>{manualError}</div>}
                <button
                  className="expand-button"
                  style={{ marginTop: '0.5rem' }}
                  disabled={!manualText.trim() || manualLoading}
                  onClick={async () => {
                    setManualLoading(true);
                    setManualError('');
                    try {
                      const resp = await fetch('/api/instagram/post-transcript-manual', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ postUrl: transcriptBody?.postUrl || '', transcript: manualText }),
                      });
                      const data = await resp.json();
                      if (!resp.ok) throw new Error(data.error || 'Failed to save transcript');
                      setTranscript(data.transcript);
                      setError('');
                    } catch (err) {
                      setManualError(err.message || 'Failed to save transcript');
                    } finally {
                      setManualLoading(false);
                    }
                  }}
                >
                  {manualLoading ? 'Saving…' : 'Use this transcript'}
                </button>
              </div>
            </div>
          )}
          {!loading && !error && transcript && (
            <div className={`transcript-box ${expanded ? 'expanded' : ''}`}>
              <p className="transcript-text">{transcript}</p>
              {!expanded && <div className="transcript-fade" />}
            </div>
          )}
          {!loading && !error && transcript && (
            <button className="expand-button" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Collapse' : 'Expand full transcript'}
            </button>
          )}

          <h3 className="section-label">Your Business Context</h3>
          <p className="reference-note">
            Describe your business/offer once — it’s saved locally and reused for outline generation.
          </p>
          <textarea
            className="business-context-input"
            rows={3}
            placeholder="e.g. We’re an AI automation agency that builds custom workflows for small businesses"
            value={businessContext}
            onChange={(e) => setBusinessContext(e.target.value)}
            onBlur={handleBusinessContextBlur}
          />

          {!transcript ? (
            <div className="status">Outline and assets generation need a transcript first.</div>
          ) : (
            <>
              <button
                className="expand-button generate-both-button"
                onClick={handleGenerateBoth}
                disabled={(outlineLoading || assetsLoading) || !businessContext.trim()}
                title={!businessContext.trim() ? 'Add your business context above before generating' : undefined}
              >
                {outlineLoading || assetsLoading ? 'Generating…' : 'Generate Outline + Assets Breakdown'}
              </button>

              <div className="result-tabs">
                <div className="result-tab-bar">
                  <button
                    className={`result-tab-btn${activeResultTab === 'outline' ? ' active' : ''}`}
                    onClick={() => setActiveResultTab('outline')}
                  >
                    Video Outline
                  </button>
                  <button
                    className={`result-tab-btn${activeResultTab === 'assets' ? ' active' : ''}`}
                    onClick={() => setActiveResultTab('assets')}
                  >
                    Required Assets
                  </button>
                </div>

                {activeResultTab === 'outline' && (
                  <div className="result-tab-panel">
                    <button
                      className="expand-button"
                      onClick={handleGenerateOutline}
                      disabled={outlineLoading || !businessContext.trim()}
                      title={!businessContext.trim() ? 'Add your business context above first' : undefined}
                    >
                      {outlineLoading ? 'Generating…' : 'Generate Outline'}
                    </button>
                    {outlineLoading && <div className="status">Generating outline…</div>}
                    {outlineError && <div className="error">{outlineError}</div>}
                    {!outlineLoading && !outlineError && outline && (
                      <div className="outline-sections">
                        {[['Hook', outline.hook], ['Demo', outline.demo], ['Conclusion', outline.conclusion]].map(
                          ([label, bullets]) =>
                            bullets && bullets.length > 0 ? (
                              <div className="outline-block" key={label}>
                                <h4 className="outline-block-label">{label}</h4>
                                <ul className="outline-bullet-list">
                                  {bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}
                                </ul>
                              </div>
                            ) : null
                        )}
                      </div>
                    )}
                  </div>
                )}

                {activeResultTab === 'assets' && (
                  <div className="result-tab-panel">
                    <button
                      className="expand-button"
                      onClick={handleGenerateAssetsBreakdown}
                      disabled={assetsLoading || !businessContext.trim()}
                      title={!businessContext.trim() ? 'Add your business context above first' : undefined}
                    >
                      {assetsLoading ? 'Generating…' : 'Generate Assets Breakdown'}
                    </button>
                    {assetsLoading && <div className="status">Generating assets breakdown…</div>}
                    {assetsError && <div className="error">{assetsError}</div>}

                    {!assetsLoading && !assetsError && contentType && (
                      <span className={`content-type-badge content-type-${contentType}`}>
                        {contentType.charAt(0).toUpperCase() + contentType.slice(1)}
                      </span>
                    )}

                    {!assetsLoading && !assetsError && (!assetSteps || assetSteps.length === 0) && assetNote && (
                      <div className="status">{assetNote}</div>
                    )}

                    {!assetsLoading && !assetsError && assetSteps && assetSteps.length > 0 && (
                      <ol className="asset-checklist">
                        {assetSteps.map((step, i) => (
                          <li key={i} className="asset-checklist-item">
                            <div className="asset-checklist-header">
                              <span className="asset-step-name">{step.stepName}</span>
                              <span className={`difficulty-badge difficulty-${step.difficulty.toLowerCase()}`}>
                                {step.difficulty}
                              </span>
                            </div>
                            <p className="asset-step-description">{step.description}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}