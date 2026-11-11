import { useEffect, useRef, type ReactNode } from 'react';
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import './ui/foundation.css';

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
  const requestedValue = useRef(value);
  useEffect(() => {
    requestedValue.current = value;
  }, [value]);
  const change = (next: string) => {
    const selected = items.find((item) => item.value === next);
    if (selected && selected.value !== requestedValue.current) {
      // Pointer activation can notify through both focus and mouse-down before React commits.
      requestedValue.current = selected.value;
      onChange(selected.value);
    }
  };
  return (
    <UiTabs
      className={`console-tabset ${className}`}
      value={value}
      onValueChange={change}
      activationMode="automatic"
    >
      <TabsList className="console-tablist" aria-label={label} loop>
        {items.map((item) => (
          <TabsTrigger className="console-tab-trigger" type="button" key={item.value} value={item.value}>
            {item.label}
            {item.count != null && <span className="tab-count">{item.count}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={value} className="console-tabpanel">
        {children(value)}
      </TabsContent>
    </UiTabs>
  );
}
