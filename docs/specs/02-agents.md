# 02 · Specialists and chains

## Outcome
Provide PM, Designer, Developer, QA, Manager, DevOps and CISO as versioned local specialists. A chain is a specialist's bounded procedure; a flow coordinates specialists. Do not implement another scheduler.

## Interfaces and behavior
Add catalog, draft, validation and publish operations to the authenticated application service and API. Drafts include instructions, registered steps, skill versions, model selection, tool allowlists and context policy. Compare revisions on edits. Publish only a validated definition; runs retain immutable snapshots.

Preserve legacy execution contracts through explicit role adapters. PM handles requirements; Developer owns code architecture; Designer owns UX and visual evidence. Manager coordination and review use separate invocations and contexts. DevOps prepares delivery; CISO cannot waive checks. Model capability checks block unsupported visual review rather than claiming it happened.

Display the Manager specialist as Supervisor in the operator experience. It remains an agent, accessible for both runtime coordination and human conversation. Separate conversation, coordination and independent judging invocation contexts; chatting must not contaminate the independent review or bypass deterministic policy. Preserve legacy manager/supervisor role identifiers through the compatibility adapter.

Organizational scopes follow the factory analogy without introducing gratuitous model calls: the authenticated owner grants authority; the factory-level chief engineer selects approved processes and coordinates across runs; each run's Supervisor follows its project execution; specialist workers perform tasks; tools/runners are machines; versioned flows/chains are processes. Implement the chief engineer and run Supervisor as explicitly scoped capabilities of the control agent, with separate contexts and grants. A local run decision cannot mutate factory-wide policy, reassign another run or spend its budget. Deterministic scheduling, arbitration and authorization remain code paths, not extra agents. Independent review remains isolated from both coordination conversations.

## Acceptance
Changing a draft or publishing a new version cannot alter an active run. Skills and instructions cannot grant tools. Test separate review context, invalid chains, bounded repair, missing model capabilities and historical role compatibility. UI exposes Overview, Chain, Instructions & skills, Tools, Context and Versions.
