import type { RunUsageSnapshot } from '../api';

export function runUsageSnapshot(workId: string, calls = 0, measuredTokens = 0): RunUsageSnapshot {
  return {
    version: 1,
    work_id: workId,
    usage: {
      calls,
      settled_calls: calls,
      unsettled_calls: 0,
      tokens: measuredTokens,
      measured_tokens: measuredTokens,
      unknown_reserved_tokens: 0,
      cost_usd: 0,
    },
    measured_api_cost_usd: calls ? 0 : null,
    reserved_api_cost_usd: 0,
    reported_cost_usd: null,
  };
}
