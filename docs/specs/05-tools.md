# 05 · Tools and credentials

## Outcome
Unify built-in tools, outbound MCP and registered direct API adapters while retaining their distinct capabilities. Agents exposed as MCP tools also appear as external specialists with explicit bindings.

## Interfaces and behavior
Reuse existing connection and credential services. Add safe adapter metadata and connection diagnostics where missing. Model connection availability, credential presence, reviewed tool manifest and effective agent/project/run permissions separately. Effective access is their intersection.

Direct API execution uses registered typed adapters, not an arbitrary HTTP request tool. Discovery and diagnostics cannot perform business mutations. Credentials remain write-only and destination-scoped. Reuse protected transport, host restrictions, bounded payloads and redirect policy. Contract changes disable the affected approval until reviewed.

## Console
The Tools section groups connections by the service the owner recognises, one tab each: GitHub, MCP servers, Notifications and Built-in tools. The address keeps the tab (`/tools?tab=mcp`), and `/tools?connection=<id>` opens that connection's details without changing anything. Model providers are not listed here; they are connected in Config.

Every connection is one row that states what it is, whether it is enabled and whether its credential is saved, and carries its own actions: add or replace the credential, enable or disable, edit a dynamic MCP server. Details open in place and hold the stored credential, the registered operations with their effect and granted specialists and, for an MCP server, the comparison of the remote manifest with the reviewed contracts. Nothing has to be selected in one panel to act in another, and no view exists only to describe another view. The write-only credential editor opens on an explicit action, never because a page or a row was opened.

The GitHub tab holds the connection and the three access switches. A repository becomes a project in Projects ([13](13-projects.md)); the tab links to its Add project dialog and neither imports nor creates. MCP access by project is granted from the MCP tab. The Notifications tab shows the owner channel and the delivery log, which loads with the tab.

Built-in tools are a read-only catalog that can be filtered by specialist. It is read from the registration a run uses, for every role, so a tool a specialist is given is a tool the owner is shown: workspace reads and writes, search, commands, dependency preparation, recovering earlier output, reading and proposing memory, work notes and the browser check. Each entry names the roles that may call it and its effect. A tool defined differently for a role, as `execute` is for QA, carries that definition beside the first. A run offers a tool only when what it needs exists; the catalog lists what can be offered.

## Acceptance
Test disabled connection, missing credential, manifest drift, revoked credentials, excessive response size, SSRF attempts and agent/project mismatches. Diagnose failures without returning upstream secrets. Verify UI changes only the selected connection and never grants global access implicitly. Browser tests cover every tab on desktop and mobile with the accessibility checks, a connection link that opens its row without a write, and the credential editor opening only on an explicit action.
