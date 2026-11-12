import type { ConfigurationHistory, RuntimeSettings } from '../api';

export function runtimeSettings(): RuntimeSettings {
  return {
    execution_slots: { value: 2, env_var: 'SABRE_EXECUTION_SLOTS' },
    panel_session_days: { value: 30, env_var: 'SABRE_PANEL_SESSION_DAYS' },
    allowed_origins: { value: ['http://127.0.0.1:8000'], env_var: 'SABRE_ALLOWED_ORIGINS' },
    monthly_budget_usd: { value: 0, env_var: 'SABRE_MONTHLY_BUDGET_USD' },
    chat_budget_usd: { value: 0.25, env_var: 'SABRE_CHAT_BUDGET_USD' },
    webhooks: { value: [], env_var: 'SABRE_WEBHOOKS' },
    otlp: { configured: true, host: 'jaeger', env_var: 'SABRE_OTLP_ENDPOINT' },
    sandbox: {
      memory: { value: '2g', env_var: null },
      cpus: { value: 1, env_var: null },
      pids: { value: 256, env_var: null },
      default_timeout_s: { value: 300, env_var: null },
      max_timeout_s: { value: 1800, env_var: null },
      network_default: { value: 'none', env_var: null },
    },
  };
}

export function configurationHistory(): ConfigurationHistory {
  return {
    truncated: false,
    items: [
      {
        revision: 2,
        actor: 'owner',
        created_at: '2026-11-10T09:00:00Z',
        changed_paths: ['models.roles.developer'],
        changed_paths_truncated: false,
        summary: 'Changed 1 setting: models.roles.developer',
      },
      {
        revision: 1,
        actor: 'owner',
        created_at: '2026-11-08T09:00:00Z',
        changed_paths: ['context.max_input_bytes'],
        changed_paths_truncated: false,
        summary: 'Changed 1 setting: context.max_input_bytes',
      },
    ],
  };
}
