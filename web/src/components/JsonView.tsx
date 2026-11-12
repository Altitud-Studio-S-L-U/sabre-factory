import { useState } from 'react';
import Button from './Button';

export default function JsonView({ value, label = 'JSON' }: { value: unknown; label?: string }) {
  const [notice, setNotice] = useState('');
  const text = JSON.stringify(value, null, 2);
  return (
    <div data-slot="json-view" className="min-w-0 overflow-hidden rounded-md border border-border bg-code">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span>{label}</span>
        <Button
          variant="link"
          size="sm"
          className="px-0"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => setNotice('Copied'))
              .catch(() => setNotice('Copy unavailable. Select the JSON to copy it.'));
          }}
        >
          Copy JSON
        </Button>
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-120 overflow-auto p-3 font-mono text-xs leading-relaxed"
      >
        <code>{text}</code>
      </pre>
      <span className="sr-only" role="status">
        {notice}
      </span>
    </div>
  );
}
