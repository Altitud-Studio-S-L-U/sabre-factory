# 02 · Specialists and chains

## Outcome
Provide PM, Designer, Developer, QA, Manager, DevOps and CISO as versioned local specialists. A chain is a specialist's bounded procedure; a flow coordinates specialists. Do not implement another scheduler.

## Interfaces and behavior
Add catalog, draft, validation and publish operations to the authenticated application service and API. Drafts include instructions, registered steps, skill versions, model selection, tool allowlists and context policy. Compare revisions on edits. Publish only a validated definition; runs retain immutable snapshots.

Preserve legacy execution contracts through explicit role adapters. PM handles requirements; Developer owns code architecture; Designer owns UX and visual evidence. Manager coordination and review use separate invocations and contexts. DevOps prepares delivery; CISO cannot waive checks. Model capability checks block unsupported visual review rather than claiming it happened.

Display the Manager specialist as Supervisor in the operator experience. It remains an agent, accessible for both runtime coordination and human conversation. Separate conversation, coordination and independent judging invocation contexts; chatting must not contaminate the independent review or bypass deterministic policy. Preserve legacy manager/supervisor role identifiers through the compatibility adapter.

Organizational scopes follow the factory analogy without introducing gratuitous model calls: the authenticated owner grants authority; the factory-level chief engineer selects approved processes and coordinates across runs; each run's Supervisor follows its project execution; specialist workers perform tasks; tools/runners are machines; versioned flows/chains are processes. Implement the chief engineer and run Supervisor as explicitly scoped capabilities of the control agent, with separate contexts and grants. A local run decision cannot mutate factory-wide policy, reassign another run or spend its budget. Deterministic scheduling, arbitration and authorization remain code paths, not extra agents. Independent review remains isolated from both coordination conversations.

## Acceptance
Changing a draft or publishing a new version cannot alter an active run. Skills and instructions cannot grant tools. Each skill is a Markdown file in `backend/src/sabre/skills/` with the roles that may use it and one instruction; its digest is pinned by published definitions and resolved flows, so editing a skill is a reviewed change that those definitions must adopt by being published again. Test separate review context, invalid chains, bounded repair, missing model capabilities and historical role compatibility. UI exposes Overview, Chain, Instructions & skills, Tools, Context and Versions.

## Default methods

Each default definition includes a mission and a concrete procedure for each registered capability. Keep one procedure step per capability unless an additional model invocation has a demonstrated purpose. The PM uses the `requirements` skill for proportional discovery, example mapping, observable acceptance, evidence-to-verification traceability and material clarification. Analysis can complete before deterministic checks run. Designer uses `product_design` for journeys, states, interaction and evidence limits; DevOps uses `delivery` for scoped operational readiness and recovery. Developer, QA, Supervisor and CISO retain their role-specific engineering, verification, review and security methods.

The effective model context combines platform policy, the role contract, the pinned definition, the capability procedure, selected skill instructions and scoped source/task evidence. Inspect and test this composition rather than treating the editable mission text as the whole prompt. A skill remains procedural knowledge, not an execution grant. The current small catalogue is selected and embedded by phase; automatic discovery of third-party `SKILL.md` packages, executable resources and progressive loading are not implemented.

New defaults apply to new installations. An existing installation retains its published versions until the owner saves, validates and publishes an updated definition through the application. Preserve custom model/tool/context choices and active run snapshots. Adding a skill should not rewrite existing skill files and invalidate their pinned digests.

These methods follow the separation of model, tool and persistent context described in [LangChain's context engineering guide](https://docs.langchain.com/oss/python/langchain/context-engineering). The distinction between phase-selected instruction files and dynamically loaded resources is material: [Agent Skills](https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills) describes the latter. Behavioural and cost evaluation is still required; longer instructions alone do not prove a better specialist.
