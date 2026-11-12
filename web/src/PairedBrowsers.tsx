import { useCallback, useEffect, useState } from 'react';
import type { Api, PairedBrowsers as PairedBrowsersView } from './api';
import Button from './components/Button';

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

  const load = useCallback(async () => {
    try {
      // A reload keeps any revocation failure visible; revoke() clears it when retried.
      const value = await api.pairedBrowsers();
      if (!Array.isArray(value?.browsers)) throw new Error('Unexpected paired browser response');
      setView(value);
    } catch {
      setError('Paired browsers could not be loaded. Retry when connected.');
    }
  }, [api]);

  useEffect(() => {
    void load();
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
    <section className="operator-panel" aria-labelledby="paired-browsers-title">
      <h2 id="paired-browsers-title">Paired browsers</h2>
      <p>
        Each browser opened with <code>node bin/sabre.mjs open</code> or at startup stays signed in while it
        is used
        {view ? ` and signs out after ${view.lifetime_days} days without use` : ''}. Pairing needs the
        launcher on this machine; containers and agents cannot create a session. Revoking signs that browser
        out on its next request.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!view && !error && <p role="status">Loading paired browsers…</p>}
      {view && view.browsers.length === 0 && <p>No browser is paired.</p>}
      {view && view.browsers.length > 0 && (
        <ul className="paired-browsers" aria-label="Paired browsers">
          {view.browsers.map((browser) => (
            <li key={browser.id}>
              <div>
                <strong>{browser.client}</strong>
                {browser.current && <span className="paired-browser-current">This browser</span>}
                <p>
                  Paired {formatTime(browser.created_at)} · Last used {formatTime(browser.last_used_at)} ·
                  Expires {formatTime(browser.expires_at)} unless used
                </p>
              </div>
              {!browser.current && (
                <Button
                  className="button danger"
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
      <p>To sign this browser out, use Sign out in the header.</p>
    </section>
  );
}
