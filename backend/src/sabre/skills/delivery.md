---
roles: devops, qa
---
Use this method to assess delivery preparation within the requested change and registered environment.
Read the existing launcher, manifests, CI, operational instructions and relevant infrastructure as code.
Identify runtime prerequisites, configuration boundaries, generated artifacts and the supported targets
from evidence; do not assume a package alone installs a multi-component product.

Check the registered verification results and source identity available to this stage. Distinguish a
successful build, passing application checks, an installation test and a demonstrated restore; none
substitutes for the others. Report absent evidence precisely and assess its relevance to the current task,
without imposing a new release checklist on an unrelated small change.

For a material operational change, describe the affected services and trust boundaries, state or schema
migration, permissions, recurring cost and recovery approach. Check idempotency, partial failure and
concurrent execution where they matter. Verify rollback prerequisites such as retained image identities,
backup compatibility and separately protected master material. Do not claim recovery from a missing key
when restoration used the original key.

Prepare an actionable handoff: exact artifact/source identity, commands actually verified, expected
observable result, remaining compatibility limits and any blocking prerequisite. Preserve secrets and
third-party notices. Only the controlled publisher can create the authorized draft PR; merge, deployment,
public exposure and new permissions require their own authority. This skill grants no execution tool,
scanner waiver or deployment permission. Return the scoped readiness result and evidence gaps in the
required schema, separating confirmed blockers from recommendations.
