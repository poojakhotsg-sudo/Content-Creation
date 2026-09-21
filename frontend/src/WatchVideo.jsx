import React, { useEffect, useRef, useState } from 'react';

// Standalone "Watch Backup" page — paste a URL, analyze it in the background,
// poll for the result. Separate from the Instagram/YouTube tabs.
export default function WatchVideo() {
  const [url, setUrl] = useState('');
  const [businessContext, setBusinessContext] = useState(
    () => localStorage.getItem('businessContext') || ''
  );
  // idle | processing | generating | done | failed
  const [status, setStatus] = useState('idle');
  // transcript | outline | assets  (sub-step while working)
  const [stage, setStage] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const pollRef = useRef(null);
  const pollAttemptsRef = useRef(0);

  const POLL_INTERVAL_MS = 4000;
  const MAX_POLL_ATTEMPTS = Math.ceil((6 * 60 * 1000) / POLL_INTERVAL_MS);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function handleBusinessContextBlur() {
    localStorage.setItem('businessContext', businessContext);
  }

  function stageLabel(s) {
    if (s === 'transcript') return 'Fetching transcript…';
    if (s === 'outline')    return 'Transcript ready — generating video outline…';
    if (s === 'assets')     return 'Outline ready — generating assets breakdown…';
    return 'Analyzing video… this can take a minute or two.';
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
      } else if (data.status === 'failed') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setStatus('failed');
        setError(data.error || 'Watch job failed');
      } else if (data.status === 'generating') {
        // Show partial transcript immediately as it arrives
        setStatus('generating');
        setStage(data.stage || '');
        if (data.result) setResult(data.result);
      } else {
        // 'processing' — transcript fetch still in progress
        setStatus('processing');
        setStage(data.stage || 'transcript');
      }
    } catch (err) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setStatus('failed');
      setError(err.message || 'Failed to check job status');
    }
  }

  async function handleSubmit() {
    if (!url.trim() || status === 'processing' || status === 'generating') return;
    setStatus('processing');
    setStage('transcript');
    setResult(null);
    setError('');
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

  const isWorking = status === 'processing' || status === 'generating';

  return (
    <div className="video-detail">
      <h3 className="section-label">Video URL</h3>
      <p className="reference-note">
        Paste a YouTube or Instagram video URL. The transcript is fetched first,
        then the outline and assets breakdown are generated automatically.
      </p>
      <input
        className="business-context-input"
        type="text"
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={isWorking}
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
        disabled={!url.trim() || isWorking}
      >
        {isWorking ? 'Processing…' : 'Analyze Video'}
      </button>

      {/* Live stage progress */}
      {isWorking && (
        <div className="status status-loading">
          <span className="spinner" aria-hidden="true" />
          {stageLabel(stage)}
        </div>
      )}

      {status === 'failed' && <div className="error">{error}</div>}

      {/* Transcript — show as soon as it arrives (even while outline/assets still generating) */}
      {(status === 'done' || status === 'generating') && result?.transcript && (
        <>
          <h3 className="section-label">Transcript</h3>
          <div className="transcript-box expanded">
            <p className="transcript-text">{result.transcript}</p>
          </div>
        </>
      )}

      {/* Second spinner shown below the transcript while Groq calls are in flight */}
      {status === 'generating' && result?.transcript && (
        <div className="status status-loading" style={{ marginTop: '1rem' }}>
          <span className="spinner" aria-hidden="true" />
          {stage === 'outline'
            ? 'Generating video outline…'
            : 'Generating assets breakdown…'}
        </div>
      )}

      {/* Video Outline + Required Assets — shown only once fully done */}
      {status === 'done' && result && (
        <>
          <h3 className="section-label">Video Outline</h3>
          {result.outline ? (
            <div className="outline-sections">
              {[
                ['Hook', result.outline.hook],
                ['Demo', result.outline.demo],
                ['Conclusion', result.outline.conclusion],
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
          ) : (
            <div className="error">
              {result.outlineError || 'Outline generation failed for an unknown reason.'}
            </div>
          )}

          <h3 className="section-label">Required Assets</h3>
          {result.assetsBreakdown ? (
            <>
              {result.assetsBreakdown.contentType && (
                <span
                  className={`content-type-badge content-type-${result.assetsBreakdown.contentType}`}
                >
                  {result.assetsBreakdown.contentType.charAt(0).toUpperCase() +
                    result.assetsBreakdown.contentType.slice(1)}
                </span>
              )}
              {(!result.assetsBreakdown.steps || result.assetsBreakdown.steps.length === 0) &&
                result.assetsBreakdown.note && (
                  <div className="status">{result.assetsBreakdown.note}</div>
                )}
              {result.assetsBreakdown.steps && result.assetsBreakdown.steps.length > 0 && (
                <ol className="asset-checklist">
                  {result.assetsBreakdown.steps.map((step, i) => (
                    <li key={i} className="asset-checklist-item">
                      <div className="asset-checklist-header">
                        <span className="asset-step-name">{step.stepName}</span>
                        <span
                          className={`difficulty-badge difficulty-${step.difficulty.toLowerCase()}`}
                        >
                          {step.difficulty}
                        </span>
                      </div>
                      <p className="asset-step-description">{step.description}</p>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <div className="error">
              {result.assetsError || 'Assets breakdown generation failed for an unknown reason.'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
