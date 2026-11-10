import type { ModelConfiguration } from '../api';

export function configuration(): ModelConfiguration {
  const general = {
    provider: 'codex_cli' as const,
    name: '',
    destination: 'http://codex-runner:8091',
    input_usd_per_million: 0,
    output_usd_per_million: 0,
    max_output_tokens: 4096,
  };
  return {
    revision: 0,
    default: general,
    roles: (['supervisor', 'analyst', 'architect', 'developer', 'qa', 'reviewer', 'security'] as const).map(
      (role) => ({ role, override: null, effective: general, credential_target: null }),
    ),
    runners: [
      { provider: 'codex_cli', available: true, authenticated: true, busy: false, error_code: null },
      { provider: 'claude_cli', available: true, authenticated: false, busy: false, error_code: null },
    ],
  };
}
