import { createContext } from 'react';

/**
 * The address a trace opens at in the operator's viewer, with `{trace_id}` in it, or null when
 * none is configured. The run inspector links a span's trace there; without it, it shows the
 * identifiers only.
 */
export const TraceViewer = createContext<string | null>(null);

/** The viewer address the factory reports, when it is an http(s) template that names the trace. */
export function traceViewerOf(status: Record<string, unknown>): string | null {
  const template = (status.telemetry as { viewer_url?: unknown } | undefined)?.viewer_url;
  if (typeof template !== 'string' || !template.includes('{trace_id}')) return null;
  return traceLink(template, '0'.repeat(32)) ? template : null;
}

/** The address of one trace, or null unless both the template and the identifier are well formed. */
export function traceLink(template: string | null, traceId: string | null | undefined): string | null {
  if (!template || !traceId || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  try {
    const url = new URL(template.replace('{trace_id}', traceId));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
