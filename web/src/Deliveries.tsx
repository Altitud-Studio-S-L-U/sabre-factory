import { useState } from 'react';
import Credentials from './Credentials';
import { type Api, type DeliveryStatus } from './api';

export default function Deliveries({ api }: { api: Api }) {
  const [items, setItems] = useState<DeliveryStatus[] | null>(null);
  const [keys, setKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async (id?: string) => {
    setBusy(true);
    setError('');
    try {
      setItems(id ? await api.retryDelivery(id) : await api.deliveries());
    } catch {
      setError('Delivery status could not be refreshed. Check the connection and retry.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="integration-section" aria-labelledby="deliveries-title">
      <h2 id="deliveries-title">Delivery notifications</h2>
      <p>
        Slack and signed webhooks use persistent delivery records. Failed deliveries stay visible after
        bounded retries.
      </p>
      <button type="button" className="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? 'Loading…' : 'Refresh deliveries'}
      </button>
      <button type="button" className="button" onClick={() => setKeys(!keys)}>
        {keys ? 'Close signing keys' : 'Manage webhook signing keys'}
      </button>
      {keys && <Credentials api={api} targetPrefix="webhook." onChanged={async () => undefined} />}
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && <p>No deliveries recorded.</p>}
      {!!items?.length && (
        <div className="table-scroll">
          <table>
            <caption>Latest delivery records</caption>
            <thead>
              <tr>
                <th scope="col">Destination</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Result</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.destination.split(':')[0]}</td>
                  <td>{item.state}</td>
                  <td>{item.attempts}</td>
                  <td>{item.last_error || '—'}</td>
                  <td>
                    {item.state === 'failed' ? (
                      <button
                        type="button"
                        className="button small"
                        disabled={busy}
                        onClick={() => void refresh(item.id)}
                      >
                        Retry delivery
                      </button>
                    ) : item.state === 'uncertain' ? (
                      'Reconciliation required'
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
