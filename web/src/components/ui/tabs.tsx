// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '../../lib/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'sf:inline-flex sf:h-9 sf:items-center sf:justify-center sf:rounded-lg sf:bg-muted sf:p-1 sf:text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'sf:inline-flex sf:items-center sf:justify-center sf:whitespace-nowrap sf:rounded-md sf:px-3 sf:py-1 sf:text-sm sf:font-medium sf:ring-offset-background sf:transition-all sf:focus-visible:outline-none sf:focus-visible:ring-2 sf:focus-visible:ring-ring sf:focus-visible:ring-offset-2 sf:disabled:pointer-events-none sf:disabled:opacity-50 sf:data-[state=active]:bg-background sf:data-[state=active]:text-foreground sf:data-[state=active]:shadow',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'sf:mt-2 sf:ring-offset-background sf:focus-visible:outline-none sf:focus-visible:ring-2 sf:focus-visible:ring-ring sf:focus-visible:ring-offset-2',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
