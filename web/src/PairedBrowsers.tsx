import { useCallback, useEffect, useState } from 'react';
import type { Api, PairedBrowsers as PairedBrowsersView } from './api';
import Button from './components/Button';
import Notice from './components/Notice';
import { Badge } from './components/ui/badge';
import { Card, CardDescription, CardTitle } from './components/ui/card';

function formatTime(value: string) {
  return new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Config > Access: browsers paired with this factory, with revocation. */
export default function PairedBrowsers({
  api,
}: {
  api: Pick<Api, 'pairedBrowsers' | 'revokePairedBrowser'>;
}) {
  const [view, setView] = useState<PairedBrowsersView | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);

  // A reload keeps any revocation failure visible; revoke() clears it when retried.
  const load = useCallback(
    (current: () => boolean = () => true) =>
      api
        .pairedBrowsers()
        .then((value) => {
          if (!Array.isArray(value?.browsers)) throw new Error('Unexpected paired browser response');
          if (current()) setView(value);
        })
        .catch(() => {
          if (current()) setError('Paired browsers could not be loaded. Retry when connected.');
        }),
    [api],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  async function revoke(id: string) {
    setPending(id);
    setError('');
    try {
      await api.revokePairedBrowser(id);
    } catch {
      setError('The browser could not be revoked. Its access remains unchanged.');
    } finally {
      setPending(null);
      await load();
    }
  }

  return (
    <Card aria-labelledby="paired-browsers-title">
      <div className="grid min-w-0 gap-1.5">
        <CardTitle id="paired-browsers-title">Paired browsers</CardTitle>
        <CardDescription>
          Each browser opened with{' '}
          <code className="font-mono text-xs text-foreground">node bin/sabre.mjs open</code> or at startup
          stays signed in while it is used
          {view ? ` and signs out after ${view.lifetime_days} days without use` : ''}. Pairing needs the
          launcher on this machine; containers and agents cannot create a session. Revoking signs that browser
          out on its next request.
        </CardDescription>
      </div>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {!view && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading paired browsers…
        </p>
      )}
      {view && view.browsers.length === 0 && <p className="text-sm">No browser is paired.</p>}
      {view && view.browsers.length > 0 && (
        <ul className="grid divide-y divide-border border-y border-border" aria-label="Paired browsers">
          {view.browsers.map((browser) => (
            <li key={browser.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3.5">
              <div className="grid min-w-0 gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm font-semibold">{browser.client}</strong>
                  {browser.current && <Badge variant="success">This browser</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Paired {formatTime(browser.created_at)} · Last used {formatTime(browser.last_used_at)} ·
                  Expires {formatTime(browser.expires_at)} unless used
                </p>
              </div>
              {!browser.current && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={pending !== null}
                  aria-label={`Revoke ${browser.client}, paired ${formatTime(browser.created_at)}`}
                  onClick={() => void revoke(browser.id)}
                >
                  {pending === browser.id ? 'Revoking…' : 'Revoke'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">To sign this browser out, use Sign out in the header.</p>
    </Card>
  );
}
