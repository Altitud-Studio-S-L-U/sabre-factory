import type { AgentCatalog, AgentCatalogEntry, AgentDefinition } from '../api';

const skillDefaults: Record<AgentDefinition['id'], AgentDefinition['skills'][number]['name'][]> = {
  pm: ['engineering', 'requirements'],
  designer: ['product_design'],
  developer: ['engineering', 'verification'],
  qa: ['verification'],
  manager: ['engineering', 'review'],
  devops: ['delivery'],
  ciso: ['security'],
};

const specifications: {
  id: AgentDefinition['id'];
  label: string;
  roles: string[];
  capabilities: AgentDefinition['chains'][number]['id'][];
}[] = [
  { id: 'pm', label: 'PM', roles: ['analyst'], capabilities: ['requirements'] },
  { id: 'designer', label: 'Designer', roles: ['designer'], capabilities: ['design'] },
  {
    id: 'developer',
    label: 'Developer',
    roles: ['architect', 'developer'],
    capabilities: ['architecture', 'implementation'],
  },
  { id: 'qa', label: 'QA', roles: ['qa'], capabilities: ['verification'] },
  {
    id: 'manager',
    label: 'Supervisor',
    roles: ['supervisor', 'reviewer'],
    capabilities: ['planning', 'review'],
  },
  { id: 'devops', label: 'DevOps', roles: ['devops'], capabilities: ['delivery'] },
  { id: 'ciso', label: 'CISO', roles: ['security'], capabilities: ['security'] },
];
export function agentCatalog(): AgentCatalog {
  return {
    version: 1,
    agents: specifications.map((item): AgentCatalogEntry => {
      const definition: AgentDefinition = {
        version: 1,
        id: item.id,
        label: item.label,
        instructions: `Synthetic published procedure for ${item.label}.`,
        chains: item.capabilities.map((capability) => ({
          version: 1,
          id: capability,
          steps: [
            { version: 1, id: capability, capability, instructions: `Synthetic ${capability} handoff.` },
          ],
        })),
        skills: skillDefaults[item.id].map((name) => ({ name, digest: 'c'.repeat(64) })),
        model: null,
        tools: null,
        context: { max_input_bytes: 98304, visual_review: false },
      };
      const published = { version: 1, digest: 'a'.repeat(64), definition: structuredClone(definition) };
      return {
        id: item.id,
        label: item.label,
        legacy_roles: item.roles,
        revision: 0,
        draft: structuredClone(definition),
        published,
        versions: [published],
        validation: { valid: true, errors: [] },
      };
    }),
  };
}
