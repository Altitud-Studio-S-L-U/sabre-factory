import { useState } from 'react';

export default function JsonView({ value, label = 'JSON' }: { value: unknown; label?: string }) {
  const [notice, setNotice] = useState('');
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="json-view">
      <div className="json-view-heading">
        <span>{label}</span>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => setNotice('Copied'))
              .catch(() => setNotice('Copy unavailable. Select the JSON to copy it.'));
          }}
        >
          Copy JSON
        </button>
      </div>
      <pre tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
      <span className="sr-only" role="status">
        {notice}
      </span>
    </div>
  );
}
