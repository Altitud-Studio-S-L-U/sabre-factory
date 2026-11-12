import { ShieldCheck } from 'lucide-react';
import { Eyebrow } from '../components/PageHeader';
import { ErrorNotice } from '../features/runs/shared';
import { Logo } from './Logo';

const flow = ['Run', 'Team', 'Verification', 'Reviewable PR'];

/** Signed-out fallback. Text carrying data-contrast is checked for contrast by the browser suite. */
export default function Login({ error, connecting }: { error: string; connecting: boolean }) {
  return (
    <div className="grid min-h-dvh bg-background text-foreground lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="flex flex-col justify-between gap-10 border-b border-border bg-sidebar px-6 py-8 sm:px-10 lg:border-r lg:border-b-0 lg:px-14 lg:py-12">
        <Logo />
        <div className="grid max-w-xl gap-4">
          <Eyebrow data-contrast>Your software factory</Eyebrow>
          <h1 data-contrast className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Work is progressing.
            <br />
            You retain control.
          </h1>
          <p data-contrast className="text-base text-muted-foreground">
            Runs, decisions and evidence in one place. Connect to SABRE to see its progress and pending
            decisions.
          </p>
        </div>
        <div
          data-contrast
          aria-label="Workflow"
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          {flow.map((step, index) => (
            <span key={step} className="flex items-center gap-2">
              {index > 0 && <span aria-hidden="true">→</span>}
              <span className="rounded-md border border-border px-2 py-1">{step}</span>
            </span>
          ))}
        </div>
      </section>
      <main className="flex items-center justify-center px-6 py-10 sm:px-10">
        <div className="grid w-full max-w-md gap-5">
          <Eyebrow>Control room</Eyebrow>
          <h2 data-contrast className="text-2xl font-semibold">
            {connecting ? 'Opening the control room' : 'Pair this browser'}
          </h2>
          {connecting ? (
            <p data-contrast role="status" className="text-sm text-muted-foreground">
              Checking the local session…
            </p>
          ) : (
            <>
              <p data-contrast className="text-sm text-muted-foreground">
                SABRE opens this panel already signed in when it starts. To pair this browser now, run this
                command from the SABRE directory:
              </p>
              <pre className="rounded-md border border-border bg-code px-4 py-3 font-mono text-sm">
                <code>node bin/sabre.mjs open</code>
              </pre>
              <p data-contrast className="text-sm text-muted-foreground">
                The browser stays signed in while you use it and signs out after 30 days without use. This tab
                checks again when you return to it.
              </p>
            </>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className="flex gap-3 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
            <p>
              Access is paired with this device by the launcher; containers cannot open a session. Revoke
              paired browsers in Config → Access.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
