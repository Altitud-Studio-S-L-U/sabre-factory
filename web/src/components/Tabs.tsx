import { useEffect, useRef, type ReactNode } from 'react';
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { cn } from '../lib/utils';

/**
 * Underline tabs over Radix. Radix derives element ids from each value, so values are passed
 * as positional keys: a label such as "Tasks & evidence" would otherwise put spaces into the
 * id references that name the panel.
 */
export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  children,
  className,
  contentClassName,
}: {
  items: { value: T; label: string; count?: number; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  children: (value: T) => ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const requestedValue = useRef(value);
  useEffect(() => {
    requestedValue.current = value;
  }, [value]);
  const keyOf = (item: T) => `tab-${items.findIndex((candidate) => candidate.value === item)}`;
  const change = (key: string) => {
    const selected = items[Number(key.slice(4))];
    if (selected && selected.value !== requestedValue.current) {
      // Pointer activation can notify through both focus and mouse-down before React commits.
      requestedValue.current = selected.value;
      onChange(selected.value);
    }
  };
  return (
    <UiTabs
      className={cn('min-w-0', className)}
      value={keyOf(value)}
      onValueChange={change}
      activationMode="automatic"
    >
      <TabsList aria-label={label} loop>
        {items.map((item) => (
          <TabsTrigger type="button" key={item.value} value={keyOf(item.value)} disabled={item.disabled}>
            {item.label}
            {item.count != null && (
              <span className="rounded-full bg-secondary px-1.5 text-xs text-muted-foreground tabular-nums">
                {item.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={keyOf(value)} className={contentClassName}>
        {children(value)}
      </TabsContent>
    </UiTabs>
  );
}
