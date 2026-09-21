import React, { useEffect, useRef, useState } from 'react';

// Standalone "Watch Backup" page — paste a URL, run the /watch skill in the
// background, poll for the result. Separate from the Instagram/YouTube tabs;
// does not touch their UI or state.
export default function WatchVideo() {
  const [url, setUrl] = useState('');
  const [businessContext, setBusinessContext] = useState(
    () => localStorage.getItem('businessContext') || ''
  );
  const [status, setStatus] = useState('idle'); // idle | processing | done | failed
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const pollRef = useRef(null);
  const pollAttemptsRef = useRef(0);

  // --- Per-section generate state (mirrors TranscriptDetail) ---
  const [outline, setOutline] = useState(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState('');

  const [assetsBreakdown, setAssetsBreakdown] = useState(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState('');

  // Safety net: matches the backend's 5-minute job timeout plus a buffer,
  // so a stuck job can't leave the UI polling forever.
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
      setStatus('failed');
      setError('Timed out waiting for the video analysis to finish. Please try again.');
      return;
    }

    try {
      const resp = await fetch(`/api/watch-status/${jobId}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to check job status');

      if (data.status === 'done') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setStatus('done');
        setResult(data.result);
        // Seed per-section state from the watch job result
        setOutline(data.result.outline || null);
        setOutlineError(data.result.outlineError || '');
        setAssetsBreakdown(data.result.assetsBreakdown || null);
        setAssetsError(data.result.assetsError || '');
      } else if (data.status === 'failed') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setStatus('failed');
        setError(data.error || 'Watch job failed');
      }
      // else still processing — keep polling
    } catch (err) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setStatus('failed');
      setError(err.message || 'Failed to check job status');
    }
  }

  async function handleSubmit() {
    if (!url.trim() || status === 'processing') return;
    setStatus('processing');
    setResult(null);
    setError('');
    setOutline(null);
    setOutlineError('');
    setAssetsBreakdown(null);
    setAssetsError('');
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
      setStatus('failed');
      setError(err.message || 'Failed to start watch job');
    }
  }

  // --- Individual generate handlers (same API as TranscriptDetail) ---

  async function handleGenerateOutline() {
    if (!result?.transcript) return;
    setOutlineLoading(true);
    setOutlineError('');
    setOutline(null);
    try {
      const resp = await fetch('/api/generate-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: result.transcript, businessContext }),
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
    if (!result?.transcript) return;
    setAssetsLoading(true);
    setAssetsError('');
    setAssetsBreakdown(null);
    try {
      const resp = await fetch('/api/generate-assets-breakdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: result.transcript }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to generate assets breakdown');
      setAssetsBreakdown({
        contentType: data.contentType || null,
        steps: data.steps || null,
        note: data.note || null,
      });
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
        Paste a YouTube or Instagram video URL. This runs the <code>/watch</code> skill
        in the background — it can take a minute or two.
      </p>
      <input
        className="business-context-input"
        type="text"
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={status === 'processing'}
      />

      <h3 className="section-label">Your Business Context</h3>
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
        disabled={!url.trim() || status === 'processing'}
      >
        {status === 'processing' ? 'Processing…' : 'Analyze Video'}
      </button>

      {status === 'processing' && (
        <div className="status status-loading">
          <span className="spinner" aria-hidden="true" />
          Analyzing video… this can take a minute or two.
        </div>
      )}
      {status === 'failed' && (
        <div className="error">
          {error}
          {error.includes('already running') && (
            <button
              className="expand-button"
              style={{ marginLeft: 12, fontSize: '0.85em' }}
              onClick={async () => {
                try {
                  const r = await fetch('/api/clear-watch-lock', { method: 'POST' });
                  if (!r.ok) throw new Error('Failed to clear lock');
                  setStatus('idle');
                  setError('');
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              Clear Lock &amp; Retry
            </button>
          )}
        </div>
      )}

      {status === 'done' && result && (
        <>
          <h3 className="section-label">Transcript</h3>
          <div className="transcript-box expanded">
            <p className="transcript-text">{result.transcript}</p>
          </div>

          {/* Generate Outline + Assets button */}
          <button
            className="expand-button generate-both-button"
            onClick={handleGenerateBoth}
            disabled={outlineLoading || assetsLoading}
          >
            {outlineLoading || assetsLoading
              ? 'Generating…'
              : 'Generate Outline + Assets Breakdown'}
          </button>

          {/* -------- Video Outline Section -------- */}
          <h3 className="section-label">Video Outline</h3>
          <button
            className="expand-button"
            onClick={handleGenerateOutline}
            disabled={outlineLoading}
            style={{ marginBottom: 8 }}
          >
            {outlineLoading ? 'Generating…' : 'Generate Outline'}
          </button>
          {outlineLoading && <div className="status">Generating outline…</div>}
          {outlineError && !outlineLoading && (
            <div className="error">{outlineError}</div>
          )}
          {!outlineLoading && !outlineError && outline && (
            <div className="outline-sections">
              {[
                ['Hook', outline.hook],
                ['Demo', outline.demo],
                ['Conclusion', outline.conclusion],
              ].map(([label, bullets]) =>
                bullets && bullets.length > 0 ? (
                  <div className="outline-block" key={label}>
                    <h4 className="outline-block-label">{label}</h4>
                    <ul className="outline-bullet-list">
                      {bullets.map((bullet, i) => (
                        <li key={i}>{bullet}</li>
                      ))}
                    </ul>
                  </div>
                ) : null
              )}
            </div>
          )}

          {/* -------- Required Assets Section -------- */}
          <h3 className="section-label">Required Assets</h3>
          <button
            className="expand-button"
            onClick={handleGenerateAssetsBreakdown}
            disabled={assetsLoading}
            style={{ marginBottom: 8 }}
          >
            {assetsLoading ? 'Generating…' : 'Generate Assets Breakdown'}
          </button>
          {assetsLoading && <div className="status">Generating assets breakdown…</div>}
          {assetsError && !assetsLoading && (
            <div className="error">{assetsError}</div>
          )}
          {!assetsLoading && !assetsError && assetsBreakdown && (
            <>
              {assetsBreakdown.contentType && (
                <span
                  className={`content-type-badge content-type-${assetsBreakdown.contentType}`}
                >
                  {assetsBreakdown.contentType.charAt(0).toUpperCase() +
                    assetsBreakdown.contentType.slice(1)}
                </span>
              )}
              {(!assetsBreakdown.steps || assetsBreakdown.steps.length === 0) &&
                assetsBreakdown.note && (
                  <div className="status">{assetsBreakdown.note}</div>
                )}
              {assetsBreakdown.steps && assetsBreakdown.steps.length > 0 && (
                <ol className="asset-checklist">
                  {assetsBreakdown.steps.map((step, i) => (
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
            </>
          )}
        </>
      )}
    </div>
  );
}
