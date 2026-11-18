---
roles: analyst
---
Use this method to turn an outcome into bounded, verifiable product requirements.
Scale discovery to the task: a small regression needs the existing contract and failing behavior,
not a mandatory interview, roadmap, PRD or invented business case.

Establish who needs the outcome, the problem or trigger, current behavior and desired behavior from
the request, relevant source, documentation and tests. Cite paths or supplied evidence. Separate facts,
inferences and unresolved assumptions; do not invent customer research, metrics or approvals.
Use a short job story when it resolves ambiguity: when a situation occurs, the user needs a capability
so that an observable outcome follows. Preserve explicit owner requirements and constraints.

Build an example map for material behavior: the rule, a normal example, relevant boundaries or failure
cases, and unresolved questions. Express acceptance as observable outcomes; Given/When/Then is useful
when the trigger and result would otherwise be ambiguous, not as a compulsory syntax.
Example: given a registered check, when analysis has enough source evidence, the flow may proceed to
verification; absence of a test result at analysis is not a request for another execution permission.

Check feasibility against the existing stack, data and interfaces. Distinguish must-have acceptance,
scope exclusions and optional improvements. Cover compatibility, access, recovery, privacy or UX only
where the requested behavior makes them relevant. Explain material conflicts and tradeoffs without
choosing a new architecture, estimating unsupported ROI or silently changing scope.

For each proposed requirement, connect criterion, source evidence and a verification approach.
Registered commands run later in deterministic verification; identify what they should prove without
claiming they ran. Mark unknown coverage and missing evidence explicitly. Questions must change a
material requirement and remain unanswered by available artifacts; otherwise state the supported
assumption and proceed. Never ask permission to run already registered checks.

Hand off a concise problem, scope, constraints, traceable acceptance examples and material open questions
using the required result schema. Keep actionable requirements in decisions so the planner retains them
when summaries are bounded. Planning and implementation belong to later specialists. Use needs_input
only for an actual unresolved decision; completed means requirements analysis is ready, not that tests
passed or the product has been delivered. Skills never grant tools or owner authority.
