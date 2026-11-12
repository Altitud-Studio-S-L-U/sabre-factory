import { Command } from 'cmdk';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect } from 'react';
import Icon, { type IconName } from '../Icon';

export interface PaletteCommand {
  id: string;
  group: 'Go to' | 'Runs' | 'Actions';
  label: string;
  hint?: string;
  icon?: IconName;
  run: () => void;
}

/** Keyboard shortcut used to open the palette: ⌘K on macOS, Ctrl+K elsewhere. */
export function isPaletteShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
  );
}

export function usePaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onOpen]);
}

/** Jump to a section, open a run or start an action without leaving the keyboard. */
export default function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
}) {
  const groups = (['Go to', 'Runs', 'Actions'] as const)
    .map((group) => ({ group, items: commands.filter((command) => command.group === group) }))
    .filter((entry) => entry.items.length > 0);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed top-[12vh] left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Icon name="search" size={16} />
              <Command.Input
                autoFocus
                placeholder="Go to a section, open a run or run an action…"
                className="h-12 w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-[min(24rem,60vh)] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing matches.
              </Command.Empty>
              {groups.map(({ group, items }) => (
                <Command.Group
                  key={group}
                  heading={group}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {items.map((command) => (
                    <Command.Item
                      key={command.id}
                      value={`${command.label} ${command.hint ?? ''} ${command.id}`}
                      onSelect={() => {
                        onOpenChange(false);
                        command.run();
                      }}
                      className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                    >
                      {command.icon && <Icon name={command.icon} size={16} />}
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.hint && (
                        <span className="shrink-0 text-xs text-muted-foreground">{command.hint}</span>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
