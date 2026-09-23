import React, { useEffect, useRef, useState } from 'react';

// Standalone "Watch Backup" page — paste a URL, run the /watch skill in the
// background, poll for the result. Once the transcript is ready, shows the
// same Generate Outline + Assets Breakdown UI as the YouTube/Instagram pages.
export default function WatchVideo() {
  const [url, setUrl] = useState('');
  const [businessContext, setBusinessContext] = useState(
    () => localStorage.getItem('businessContext') || ''
  );

  // Watch job state
  const [jobStatus, setJobStatus] = useState('idle'); // idle | processing | done | failed
  const [jobError, setJobError] = useState('');
  const [transcript, setTranscript] = useState('');
  const pollRef = useRef(null);
  const pollAttemptsRef = useRef(0);

  // Transcript expand
  const [expanded, setExpanded] = useState(false);

  // Outline state
  const [outline, setOutline] = useState(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState('');

  // Assets state
  const [assetSteps, setAssetSteps] = useState(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState('');
  const [contentType, setContentType] = useState(null);
  const [assetCategory, setAssetCategory] = useState(null);
  const [assetNote, setAssetNote] = useState(null);

  // Active result tab
  const [activeResultTab, setActiveResultTab] = useState('outline');

  // Safety net: 6-minute ceiling on polling
  const POLL_INTERVAL_MS = 4000;
  const MAX_POLL_ATTEMPTS = Math.ceil((6 * 60 * 1000) / POLL_INTERVAL_MS);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function handleBusinessContextBlur() {
    localStorage.setItem('businessContext', businessContext);
  }

  async function pollStatus(jobId) {
    pollAttemptsRef.current += 1;

    if (pollAttemptsRef.current > MAX_POLL_ATTEMPTS) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setJobStatus('failed');
      setJobError('Timed out waiting for the video analysis to finish. Please try again.');
      return;
    }

    try {
      const resp = await fetch(`/api/watch-status/${jobId}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to check job status');

      if (data.status === 'done') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setJobStatus('done');
        setTranscript(data.result?.transcript || '');
      } else if (data.status === 'failed') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setJobStatus('failed');
        setJobError(data.error || 'Watch job failed');
      }
      // else still processing — keep polling
    } catch (err) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setJobStatus('failed');
      setJobError(err.message || 'Failed to check job status');
    }
  }

  async function handleSubmit() {
    if (!url.trim() || jobStatus === 'processing') return;
    setJobStatus('processing');
    setJobError('');
    setTranscript('');
    setOutline(null);
    setOutlineError('');
    setAssetSteps(null);
    setAssetsError('');
    setContentType(null);
    setAssetCategory(null);
    setAssetNote(null);
    setExpanded(false);
    pollAttemptsRef.current = 0;

    try {
      const resp = await fetch('/api/watch-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), businessContext }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to start watch job');

      pollRef.current = setInterval(() => pollStatus(data.jobId), POLL_INTERVAL_MS);
    } catch (err) {
      setJobStatus('failed');
      setJobError(err.message || 'Failed to start watch job');
    }
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
    setAssetCategory(null);
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
      setAssetCategory(data.category || null);
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

  return (
    <div className="video-detail">
      <h3 className="section-label">Video URL</h3>
      <p className="reference-note">
        Paste a YouTube or Instagram video URL. This fetches the transcript in the background — it
        can take a minute or two.
      </p>
      <input
        className="business-context-input"
        type="text"
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={jobStatus === 'processing'}
      />

      <h3 className="section-label">Your Business Context</h3>
      <p className="reference-note">
        Describe your business/offer once — it's saved locally and reused for outline generation.
      </p>
      <textarea
        className="business-context-input"
        rows={3}
        placeholder="e.g. We're an AI automation agency that builds custom workflows for small businesses"
        value={businessContext}
        onChange={(e) => setBusinessContext(e.target.value)}
        onBlur={handleBusinessContextBlur}
      />

      <button
        className="expand-button generate-both-button"
        onClick={handleSubmit}
        disabled={!url.trim() || jobStatus === 'processing'}
      >
        {jobStatus === 'processing' ? 'Fetching transcript…' : 'Analyze Video'}
      </button>

      {jobStatus === 'processing' && (
        <div className="status status-loading">
          <span className="spinner" aria-hidden="true" />
          Analyzing video… this can take a minute or two.
        </div>
      )}
      {jobStatus === 'failed' && <div className="error">{jobError}</div>}

      {/* Once transcript is ready, show the same UI as other pages */}
      {jobStatus === 'done' && transcript && (
        <>
          <h3 className="section-label">Transcript</h3>
          <div className={`transcript-box ${expanded ? 'expanded' : ''}`}>
            <p className="transcript-text">{transcript}</p>
            {!expanded && <div className="transcript-fade" />}
          </div>
          <button className="expand-button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Collapse' : 'Expand full transcript'}
          </button>

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
                  disabled={assetsLoading}
                >
                  {assetsLoading ? 'Generating…' : 'Generate Assets Breakdown'}
                </button>
                {assetsLoading && <div className="status">Generating assets breakdown…</div>}
                {assetsError && <div className="error">{assetsError}</div>}

                {!assetsLoading && !assetsError && contentType && (
                  <span className={`content-type-badge content-type-${contentType}`}>
                    {assetCategory || (contentType.charAt(0).toUpperCase() + contentType.slice(1))}
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
    </div>
  );
}
