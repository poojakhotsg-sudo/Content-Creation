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

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function handleBusinessContextBlur() {
    localStorage.setItem('businessContext', businessContext);
  }

  async function pollStatus(jobId) {
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

    try {
      const resp = await fetch('/api/watch-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), businessContext }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to start watch job');

      pollRef.current = setInterval(() => pollStatus(data.jobId), 4000);
    } catch (err) {
      setStatus('failed');
      setError(err.message || 'Failed to start watch job');
    }
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
        placeholder="e.g. We’re an AI automation agency that builds custom workflows for small businesses"
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
        <div className="status">Watching video and analyzing… this can take a minute or two.</div>
      )}
      {status === 'failed' && <div className="error">{error}</div>}

      {status === 'done' && result && (
        <>
          <h3 className="section-label">Transcript</h3>
          <div className="transcript-box expanded">
            <p className="transcript-text">{result.transcript}</p>
          </div>

          {result.outline && (
            <>
              <h3 className="section-label">Video Outline</h3>
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
            </>
          )}

          {result.assetsBreakdown && (
            <>
              <h3 className="section-label">Required Assets</h3>
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
