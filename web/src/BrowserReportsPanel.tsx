import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api, type BrowserReport } from './api';
import JsonView from './components/JsonView';
import './BrowserReportsPanel.css';

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const viewportName = (value: unknown) => (typeof value === 'string' ? value : 'Viewport not recorded');

export default function BrowserReportsPanel({
  api,
  workId,
  sourceDigest,
  refreshKey,
}: {
  api: Api;
  workId: string;
  sourceDigest?: string;
  refreshKey?: string | number;
}) {
  const [reports, setReports] = useState<BrowserReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [images, setImages] = useState<Record<string, string>>({});
  const [pending, setPending] = useState('');
  const urls = useRef(new Set<string>());
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const activeGeneration = generation.current;
    let active = true;
    setLoading(true);
    setReports([]);
    setError('');
    setImages({});
    setPending('');
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    void api
      .browserReports(workId)
      .then(
        (items) => {
          if (active) setReports(items.filter((item) => item.work_id === workId));
        },
        (reason: unknown) => {
          if (active)
            setError(
              reason instanceof ApiError
                ? reason.message
                : 'Browser evidence is unavailable. Refresh to retry.',
            );
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (generation.current === activeGeneration) generation.current += 1;
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, [api, workId, refreshKey]);

  const showScreenshot = useCallback(
    async (digest: string) => {
      if (pending || images[digest]) return;
      const activeGeneration = generation.current;
      setPending(digest);
      setError('');
      try {
        const blob = await api.browserArtifact(workId, digest);
        if (generation.current !== activeGeneration) return;
        if (blob.type !== 'image/png') throw new Error('Unexpected screenshot type');
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        setImages((current) => ({ ...current, [digest]: url }));
      } catch {
        if (generation.current === activeGeneration)
          setError('The screenshot could not be opened with this session. Refresh access and retry.');
      } finally {
        if (generation.current === activeGeneration) setPending('');
      }
    },
    [api, workId, images, pending],
  );

  return (
    <section className="browser-evidence" aria-label="Browser verification evidence">
      <header className="browser-evidence-heading">
        <h4>Browser verification</h4>
        <span className="browser-visual-status">Visual model review unavailable</span>
      </header>
      <p className="inspector-caption">
        Recorded browser checks use synthetic previews. A passing result does not establish visual quality or
        accessibility compliance.
      </p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading browser evidence…</p>
      ) : !reports.length ? (
        <p className="inspector-empty">
          No browser verification recorded for this run. Configure an approved synthetic preview to enable the
          capability.
        </p>
      ) : (
        reports.map((report, index) => {
          const historical = !!sourceDigest && sourceDigest !== report.snapshot_digest;
          return (
            <article className="browser-report" key={`${report.snapshot_digest}-${index}`}>
              <header>
                <strong>{report.passed ? 'Recorded checks passed' : 'Recorded checks failed'}</strong>
                {historical && <span className="browser-history-label">Historical snapshot</span>}
              </header>
              <dl className="browser-report-metadata">
                <dt>Evaluator</dt>
                <dd>{report.evaluator}</dd>
                <dt>Source snapshot</dt>
                <dd>
                  <code>{report.snapshot_digest}</code>
                </dd>
              </dl>
              {report.results.map((result, resultIndex) => (
                <div className="browser-viewport-result" key={resultIndex}>
                  <strong>
                    {viewportName(result.viewport)} · {result.passed === true ? 'Passed' : 'Failed'}
                  </strong>
                  <ul>
                    {result.overflow === true && <li>Horizontal overflow detected</li>}
                    {count(result.failedRequests) > 0 && (
                      <li>Failed requests or routes: {count(result.failedRequests)}</li>
                    )}
                    {count(result.pageErrors) > 0 && <li>Page errors: {count(result.pageErrors)}</li>}
                    {count(result.consoleErrors) > 0 && (
                      <li>Console errors: {count(result.consoleErrors)}</li>
                    )}
                    {count(result.accessibility) > 0 && (
                      <li>Accessibility findings: {count(result.accessibility)}</li>
                    )}
                  </ul>
                  <details>
                    <summary>View executable checks</summary>
                    <JsonView value={result} label={`${viewportName(result.viewport)} browser checks`} />
                  </details>
                </div>
              ))}
              <div className="browser-artifacts">
                {report.artifacts.map((artifact) => (
                  <div
                    className="browser-artifact"
                    key={`${artifact.digest}-${artifact.viewport ?? artifact.kind}`}
                  >
                    <span>
                      {artifact.kind} · {artifact.viewport ?? 'report'} · {(artifact.size / 1024).toFixed(1)}{' '}
                      KiB
                    </span>
                    <code>{artifact.digest}</code>
                    {artifact.review_required ? (
                      <small>Quarantined: inspection and redaction required before exposure.</small>
                    ) : (
                      artifact.kind === 'screenshot' &&
                      artifact.media_type === 'image/png' &&
                      (images[artifact.digest] ? (
                        <img
                          src={images[artifact.digest]}
                          alt={`${artifact.viewport ?? 'Rendered'} synthetic preview for source ${report.snapshot_digest.slice(0, 12)}`}
                        />
                      ) : (
                        <button
                          type="button"
                          className="text-button"
                          disabled={!!pending}
                          onClick={() => void showScreenshot(artifact.digest)}
                        >
                          {pending === artifact.digest ? 'Opening screenshot…' : 'Show screenshot'}
                        </button>
                      ))
                    )}
                  </div>
                ))}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}
