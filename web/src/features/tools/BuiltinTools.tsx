import { useState } from 'react';
import type { BuiltinToolCatalog } from '../../api';
import EmptyState from '../../components/EmptyState';
import Field from '../../components/FormField';
import { SectionHeading } from '../../components/PageHeader';
import Select from '../../components/Select';
import { Badge } from '../../components/ui/badge';

/**
 * The tools the factory gives a specialist: what each does, its effect and who may call it. The
 * list comes from the registration a run uses, so a tool that is given is a tool that is shown.
 */
export default function BuiltinTools({ items }: { items: BuiltinToolCatalog['items'] }) {
  const [role, setRole] = useState('');
  const roles = [...new Set(items.flatMap((item) => item.roles))].sort();
  const visible = role ? items.filter((item) => item.roles.includes(role)) : items;
  return (
    <section className="grid min-w-0 gap-4" aria-labelledby="tools-builtin-title">
      <SectionHeading
        id="tools-builtin-title"
        title="Tools available to specialists"
        description="What a specialist can do inside a run. Each tool is limited to the specialists listed and to the permissions of the run; nothing here is granted globally. A run offers a tool only when what it needs exists: recovering earlier output needs an archive, and reading a memory needs one recalled for that stage."
        actions={
          roles.length > 1 && (
            <Field label="Specialist" className="min-w-44">
              <Select value={role} onChange={(event) => setRole(event.target.value)}>
                <option value="">All specialists</option>
                {roles.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          )
        }
      />
      {visible.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {visible.map((item) => {
            // A tool can be defined differently for a role: QA's `execute` runs only an approved check.
            const notes = Object.entries(item.role_notes ?? {});
            const own = role ? item.role_notes?.[role] : undefined;
            return (
              <li
                key={item.name}
                className="grid min-w-0 gap-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4 sm:px-5"
              >
                <div className="grid min-w-0 gap-1">
                  <h3 className="font-mono text-sm font-semibold [overflow-wrap:anywhere]">{item.name}</h3>
                  <p className="text-sm text-muted-foreground">{own ?? item.description}</p>
                  {!role &&
                    notes.map(([name, note]) => (
                      <p key={name} className="text-sm text-muted-foreground">
                        <span className="font-medium text-foreground">For {name}:</span> {note}
                      </p>
                    ))}
                  <p className="text-xs text-muted-foreground">{item.roles.join(' · ')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{item.effect.replaceAll('_', ' ')}</Badge>
                  <Badge variant="neutral">{item.scope}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState as="h3" title="No built-in tools registered">
          This build reports an empty tool catalog.
        </EmptyState>
      )}
    </section>
  );
}
