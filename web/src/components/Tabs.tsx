import { useId, useRef, type ReactNode } from 'react';

export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  children,
  className = '',
}: {
  items: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  children: (value: T) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );
  return (
    <div className={`console-tabset ${className}`}>
      <div className="console-tablist" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            type="button"
            role="tab"
            id={`${id}-${index}`}
            aria-controls={`${id}-panel`}
            aria-selected={value === item.value}
            tabIndex={value === item.value ? 0 : -1}
            key={item.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === 'ArrowRight') next = (index + 1) % items.length;
              else if (event.key === 'ArrowLeft') next = (index + items.length - 1) % items.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = items.length - 1;
              else return;
              event.preventDefault();
              onChange(items[next].value);
              buttons.current[next]?.focus();
            }}
          >
            {item.label}
            {item.count != null && <span className="tab-count">{item.count}</span>}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${active}`}
        className="console-tabpanel"
      >
        {children(value)}
      </div>
    </div>
  );
}
