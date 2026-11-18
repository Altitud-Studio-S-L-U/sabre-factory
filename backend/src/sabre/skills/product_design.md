---
roles: designer, architect
---
Use this method when a requested change affects a user journey, interface state or interaction.
Identify the user task, entry point, desired outcome and the existing product's design conventions.
Inspect representative components and actual behavior before proposing a new visual direction.
For a small functional fix, preserve the existing design and refine only the affected flow.

Map the important states and transitions: initial, loading, empty, success, failure, interruption and
recovery where applicable. Distinguish persisted execution state from what a new authorization permits.
A saved permission or budget change does not mean work resumed or a check passed. Give each state a
clear explanation and an action whose label describes its consequence.

Assess hierarchy, content, semantic controls, keyboard/focus behavior, responsive layout and feedback
at the relevant viewport sizes. Include accessibility and failure cases in observable acceptance criteria.
Prefer established components and native interactions; do not invent a new design system or speculative
screens for a bounded request. Use a short journey or state table only when it clarifies the change.

Tie recommendations to affected paths, user impact and a concrete way to verify them. Separate source
inspection, browser assertions and visual inspection. Request actual rendered evidence only through
available authorized tools. If the model receives no image input, report that visual review is unverified;
a screenshot file or a passing build cannot establish visual quality. Label synthetic examples.
Return prioritized actionable findings or decisions in the existing result schema. Do not modify source,
approve a missing capability, or claim research or accessibility checks that did not happen.
