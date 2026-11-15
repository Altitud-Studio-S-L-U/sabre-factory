// What the executor's acceptance script must report for the sandbox to count as isolated.
// The script (backend/tests/runtime_executor_smoke.py) drives a broker with a workspace of its own
// and prints one JSON line; the runtime check runs it inside the deployed executor.

/** The workspace of a sandbox is a 512 MiB tmpfs. */
export const WORKSPACE_BYTES = 536870912;

/**
 * The parts of the acceptance that did not hold, by name; empty when the sandbox is isolated as
 * specified. A fact the script did not report counts as not held.
 */
export function sandboxFailures(result) {
  const isolation = result?.isolation && typeof result.isolation === 'object' ? result.isolation : { unreported: true };
  const expected = ['socket', 'broker_state', 'token', 'bootstrap_files', 'bootstrap_env', 'workspace_bytes'];
  const exposed = [...new Set([...expected, ...Object.keys(isolation)])]
    .filter((key) => (key === 'workspace_bytes' ? isolation[key] !== WORKSPACE_BYTES : isolation[key] !== false));
  return [
    result?.network !== 'blocked' && 'network',
    ...exposed,
    // The fixture's check fails on the broken source and passes on the corrected one.
    !(result?.red_exit > 0 && result?.green_exit === 0) && 'gate',
    result?.orphan_recovered !== true && 'recovery',
  ].filter(Boolean);
}
