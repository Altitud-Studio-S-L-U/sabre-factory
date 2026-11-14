import { useEffect, useState } from 'react';
import Credentials from './Credentials';
import { type Api, type DeliveryStatus } from './api';
import Button from './components/Button';
import Notice from './components/Notice';
import { SectionHeading } from './components/PageHeader';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';

export default function Deliveries({ api }: { api: Api }) {
  const [items, setItems] = useState<DeliveryStatus[] | null>(null);
  const [keys, setKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // State is applied in promise callbacks, so the mount effect never sets state synchronously.
  useEffect(() => {
    let active = true;
    void api.deliveries().then(
      (value) => {
        if (active) setItems(value);
      },
      () => {
        if (active) setError('Delivery status could not be refreshed. Check the connection and retry.');
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
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
    <section className="grid min-w-0 gap-4" aria-labelledby="deliveries-title">
      <SectionHeading
        id="deliveries-title"
        title="Delivery notifications"
        description="Slack and signed webhooks use persistent delivery records. Failed deliveries stay visible after bounded retries."
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? 'Loading…' : 'Refresh deliveries'}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setKeys(!keys)}>
              {keys ? 'Close signing keys' : 'Manage webhook signing keys'}
            </Button>
          </>
        }
      />
      {keys && (
        <div className="rounded-lg border border-border bg-card p-5">
          <Credentials api={api} targetPrefix="webhook." onChanged={async () => undefined} />
        </div>
      )}
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {items?.length === 0 && <p className="text-sm text-muted-foreground">No deliveries recorded.</p>}
      {!!items?.length && (
        <Table>
          <TableCaption className="mb-3 text-xs">Latest delivery records</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Destination</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Attempts</TableHead>
              <TableHead scope="col">Result</TableHead>
              <TableHead scope="col">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.destination.split(':')[0]}</TableCell>
                <TableCell>{item.state}</TableCell>
                <TableCell className="tabular-nums">{item.attempts}</TableCell>
                <TableCell className="font-mono text-xs">{item.last_error || '—'}</TableCell>
                <TableCell>
                  {item.state === 'failed' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void refresh(item.id)}
                    >
                      Retry delivery
                    </Button>
                  ) : item.state === 'uncertain' ? (
                    'Reconciliation required'
                  ) : (
                    '—'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
