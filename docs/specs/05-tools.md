# 05 · Tools and credentials

## Outcome
Unify built-in tools, outbound MCP and registered direct API adapters while retaining their distinct capabilities. Agents exposed as MCP tools also appear as external specialists with explicit bindings.

## Interfaces and behavior
Reuse existing connection and credential services. Add safe adapter metadata and connection diagnostics where missing. Model connection availability, credential presence, reviewed tool manifest and effective agent/project/run permissions separately. Effective access is their intersection.

Direct API execution uses registered typed adapters, not an arbitrary HTTP request tool. Discovery and diagnostics cannot perform business mutations. Credentials remain write-only and destination-scoped. Reuse protected transport, host restrictions, bounded payloads and redirect policy. Contract changes disable the affected approval until reviewed.

## Acceptance
Test disabled connection, missing credential, manifest drift, revoked credentials, excessive response size, SSRF attempts and agent/project mismatches. Diagnose failures without returning upstream secrets. Verify UI changes only the selected connection and never grants global access implicitly.
