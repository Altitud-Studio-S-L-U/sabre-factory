import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api, type BrowserReport } from './api';
import Button from './components/Button';
import DescriptionList from './components/DescriptionList';
import Disclosure from './components/Disclosure';
import Experimental from './components/Experimental';
import JsonView from './components/JsonView';
import Notice from './components/Notice';
import { Badge } from './components/ui/badge';

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
  // A different run or refresh starts from an empty view; the effect below reloads it.
  const [source, setSource] = useState({ api, workId, refreshKey });
  if (source.api !== api || source.workId !== workId || source.refreshKey !== refreshKey) {
    setSource({ api, workId, refreshKey });
    setLoading(true);
    setReports([]);
    setError('');
    setImages({});
    setPending('');
  }

  useEffect(() => {
    generation.current += 1;
    const activeGeneration = generation.current;
    const objectUrls = urls.current;
    let active = true;
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
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
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
    <section className="mt-5 grid min-w-0 gap-3" aria-label="Browser verification evidence">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h4 className="text-base font-semibold">Browser verification</h4>
          <Experimental />
        </div>
        <span className="text-xs text-muted-foreground">Visual model review unavailable</span>
      </header>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Recorded browser checks use synthetic previews. A passing result does not establish visual quality or
        accessibility compliance.
      </p>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading browser evidence…
        </p>
      ) : !reports.length ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          No browser verification recorded for this run. Configure an approved synthetic preview to enable the
          capability.
        </p>
      ) : (
        reports.map((report, index) => {
          const historical = !!sourceDigest && sourceDigest !== report.snapshot_digest;
          return (
            <article
              className="grid min-w-0 gap-3.5 rounded-lg border border-border bg-card p-4"
              key={`${report.snapshot_digest}-${index}`}
            >
              <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <strong className="text-sm font-semibold">
                  {report.passed ? 'Recorded checks passed' : 'Recorded checks failed'}
                </strong>
                {historical && <Badge variant="neutral">Historical snapshot</Badge>}
              </header>
              <DescriptionList
                termWidth="8rem"
                className="text-xs"
                items={[
                  ['Evaluator', report.evaluator],
                  [
                    'Source snapshot',
                    <code key="snapshot" className="font-mono">
                      {report.snapshot_digest}
                    </code>,
                  ],
                ]}
              />
              {report.results.map((result, resultIndex) => {
                const findings = [
                  result.overflow === true && 'Horizontal overflow detected',
                  count(result.failedRequests) > 0 &&
                    `Failed requests or routes: ${count(result.failedRequests)}`,
                  count(result.pageErrors) > 0 && `Page errors: ${count(result.pageErrors)}`,
                  count(result.consoleErrors) > 0 && `Console errors: ${count(result.consoleErrors)}`,
                  count(result.accessibility) > 0 && `Accessibility findings: ${count(result.accessibility)}`,
                ].filter((finding): finding is string => !!finding);
                return (
                  <div className="grid min-w-0 gap-2 text-xs" key={resultIndex}>
                    <strong className="text-sm font-medium">
                      {viewportName(result.viewport)} · {result.passed === true ? 'Passed' : 'Failed'}
                    </strong>
                    {!!findings.length && (
                      <ul className="grid list-disc gap-0.5 pl-4.5">
                        {findings.map((finding) => (
                          <li key={finding}>{finding}</li>
                        ))}
                      </ul>
                    )}
                    <Disclosure
                      variant="plain"
                      summary="View executable checks"
                      summaryClassName="text-xs text-muted-foreground"
                    >
                      <JsonView value={result} label={`${viewportName(result.viewport)} browser checks`} />
                    </Disclosure>
                  </div>
                );
              })}
              <div className="grid min-w-0 gap-2">
                {report.artifacts.map((artifact) => (
                  <div
                    className="grid min-w-0 gap-2 border-t border-border pt-2.5 text-xs"
                    key={`${artifact.digest}-${artifact.viewport ?? artifact.kind}`}
                  >
                    <span>
                      {artifact.kind} · {artifact.viewport ?? 'report'} · {(artifact.size / 1024).toFixed(1)}{' '}
                      KiB
                    </span>
                    <code className="font-mono [overflow-wrap:anywhere]">{artifact.digest}</code>
                    {artifact.review_required ? (
                      <small className="text-xs text-muted-foreground">
                        Quarantined: inspection and redaction required before exposure.
                      </small>
                    ) : (
                      artifact.kind === 'screenshot' &&
                      artifact.media_type === 'image/png' &&
                      (images[artifact.digest] ? (
                        <img
                          className="max-h-150 w-full rounded border border-border object-contain object-top-left"
                          src={images[artifact.digest]}
                          alt={`${artifact.viewport ?? 'Rendered'} synthetic preview for source ${report.snapshot_digest.slice(0, 12)}`}
                        />
                      ) : (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="justify-self-start px-0"
                          disabled={!!pending}
                          onClick={() => void showScreenshot(artifact.digest)}
                        >
                          {pending === artifact.digest ? 'Opening screenshot…' : 'Show screenshot'}
                        </Button>
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
