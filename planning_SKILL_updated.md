---
name: planning
description: >
  Create structured strategic and implementation plans for any initiative — product launches, technical projects, engineering migrations, business goals, or personal endeavors. Use this skill whenever the user says "let's plan", "create a plan", "help me plan", "make a roadmap", "I need a strategy for", "help me think through", or any time a multi-step goal needs clear direction and sequencing. Also trigger when the user asks for a "strategy doc", "project plan", "execution plan", "game plan", or "action plan". Even if the request is vague ("I want to plan my launch"), use this skill — the intake process will surface the details needed.

  The skill always produces two documents in order: (1) a strategic plan with goals, rationale, objectives, and open questions, and (2) after user review, a concrete implementation plan with sequenced steps and explicit checkpoints where Claude should pause before proceeding.

  Both documents use markdown checkboxes (- [ ] / - [x]) for all goals, objectives, and steps. Checkboxes are checked off as work completes, so partial progress is preserved if a session ends or tokens run out mid-execution.
---

# Planning Skill

Your job is to help the user create two linked documents: a **strategic plan** and an **implementation plan**. These always happen in this order — strategic first to get alignment on direction, then implementation to define concrete steps. Don't skip ahead.

## Progress Tracking with Checkboxes

**Both the strategic plan and the implementation plan use markdown checkboxes throughout.** Every goal, objective, and implementation step is formatted as a checkbox (`- [ ] item`). As work progresses, check off each item (`- [x] item`).

This serves a specific purpose: if a session ends or tokens run out mid-execution, the checked boxes show exactly what was completed, so the next session can resume from where the last one stopped without re-reading everything.

Rules:
- All goals in the strategic plan → checkboxes
- All key objectives in the strategic plan → checkboxes
- All steps in the implementation plan → checkboxes
- All milestone reviews → checkboxes
- Check off an item only when its "Done when" condition is fully met
- Never un-check a completed item; if work needs to be redone, add a note below the item instead

## Phase 0: Intake

Before writing anything, nail down two things:

**1. Where should these plans be saved?**

Ask the user. The common options are:
- Markdown files in a specific directory (get the path)
- Notion (use Notion tools if connected)
- Google Docs (use GDocs tools if connected)
- Just shown in chat (no file saved)

**2. What are we planning?**

If the user's request already contains enough context, confirm your understanding and proceed. If it's vague, ask for:
- A one-sentence description of the goal
- Any hard constraints (timeline, budget, team size, technical requirements, etc.)

Don't pepper the user with questions. One round of intake is enough — make reasonable assumptions for anything else and flag them as assumptions in the strategic plan.

## Phase 1: Strategic Plan

Write the strategic plan and save it to the chosen location. Structure it as follows:

---

### Goals

2–5 high-level outcomes this initiative is trying to achieve. Frame them as outcomes, not tasks — "Establish a reliable CI/CD pipeline" not "Set up GitHub Actions". They should be meaningful and durable: a goal should still make sense six months from now.

**Format each goal as a checkbox:**
```
- [ ] Goal name — brief description of the outcome
```

### Rationale

For each goal, explain *why* it matters. This is where you capture the reasoning so that when priorities shift or trade-offs arise, the user can look back and understand the intent. Draw on the context the user gave you — constraints, motivations, market dynamics, technical debt, whatever is relevant. Be direct; avoid management-speak.

(Rationale is prose, not checkboxes — it doesn't get checked off.)

### Key Objectives

For each goal, list 2–4 measurable objectives that would signal the goal is being achieved. These should be concrete enough that a person could determine, unambiguously, whether each one was met.

**Format each objective as a checkbox nested under its goal:**
```
- [ ] Goal name
  - [ ] Objective 1
  - [ ] Objective 2
```

### Open Questions

List any questions that genuinely need answers before a solid implementation plan can be written. Be honest — these are real gaps, not padding. Common types:
- Decisions the user hasn't made yet (build vs. buy, team ownership, sequencing choices)
- Assumptions embedded in the plan that need validation
- Dependencies on information or people not yet accounted for

(Open questions are prose/list items, not checkboxes — they get resolved, not checked off.)

---

Once you've written and saved the strategic plan, **present the open questions to the user and wait for their answers** before proceeding to Phase 2. If the user has no answers or says "proceed anyway", treat the open questions as unresolved assumptions and note them clearly in the implementation plan.

## Phase 2: Implementation Plan

With the strategic plan approved and open questions answered (or deferred), write the implementation plan. Save it alongside the strategic plan as a linked companion document.

---

### Steps

Group steps into phases (e.g., "Phase 1: Discovery", "Phase 2: Build", "Phase 3: Launch") for any project with more than a handful of actions. Each phase ends with a **Milestone Review** (see below).

**Format each step as a checkbox:**
```
- [ ] Step name
  - **What**: specific enough to act on — not "do the research" but "read `docs/competitor-analysis.md` and summarize the top 3 differentiators"
  - **Who**: Claude, the user, a third party, or a joint decision
  - **Context needed**: the specific files, documents, and remembered decisions an executor would need to carry out this step without loading unrelated context. List them explicitly — file paths, section names, key decisions recorded elsewhere. The goal is that someone (or an agent) starting fresh on just this step knows exactly what to load. Example: `context: [strategic-plan.md §Goals, api-spec.json, decision: use strangler-fig migration pattern]`
  - **Done when**: a concrete, unambiguous definition of completion
```

The context field is important: it lets each step be handed off to a focused agent or resumed later without re-reading everything. If a step needs no external context beyond what's in the step itself, say so explicitly (`context: none`).

**When resuming a plan mid-execution:** scan for the first unchecked `- [ ]` step to find where to pick up. Checked `- [x]` steps are complete; do not re-do them.

### Milestone Reviews

At the end of each phase, insert a named **Milestone Review** step as a checkbox. Its job is to look across all the steps in that phase and check:
- Are the outputs from each step consistent with each other? (No contradictions in naming, structure, assumptions, or decisions)
- Do the outputs collectively fulfill the phase's deliverable?
- Did any step surface new information that should update the strategic plan's open questions or assumptions?
- Are there any gaps that would cause the next phase to stumble?

The Milestone Review step should also list the specific outputs it needs to examine (files produced by each preceding step in the phase). If inconsistencies are found, the review step resolves them before the next phase begins — don't carry forward unresolved contradictions.

Example milestone review step:

```
- [ ] Phase 1 Milestone Review
  - **Context needed**: `discovery/competitor-summary.md`, `discovery/user-interview-notes.md`, `discovery/technical-audit.md`, `strategic-plan.md §Objectives`
  - **Done when**: All Phase 1 outputs reviewed for consistency, any contradictions resolved in-place, a one-paragraph phase summary written to `milestones/phase-1-summary.md`, and the team agrees to proceed to Phase 2.
```

### Clarification Checkpoints

Be explicit about the conditions under which Claude should stop and check in with the user before continuing. The purpose here is to avoid wasted effort or irreversible mistakes. Think carefully about where the risk is highest in this particular plan. Examples:
- "Before deleting or overwriting any files, show the user the list and get confirmation"
- "If the implementation of Phase 2 takes more than 3 hours of Claude time, pause and check in"
- "Before sending any external communications, present the draft for user review"
- "If a step requires access to production systems, confirm before proceeding"

Make these checkpoints concrete and named — both you and the user should know exactly when a pause is expected.

---

## Storage Instructions

### Markdown files
Save the strategic plan as `strategic-plan.md` and the implementation plan as `implementation-plan.md` in the directory the user specified. If the directory doesn't exist, ask before creating it. Use clean markdown with headers matching the structure above. Add a link from `implementation-plan.md` back to `strategic-plan.md` at the top.

### Notion
Use Notion tools to create pages. Create a parent page (e.g., "[Project Name] Planning") with two child pages: one for the strategic plan and one for the implementation plan. Cross-link them.

### Google Docs
Use Google Docs tools if available. Create two docs in the user's specified location, with the implementation plan including a link to the strategic plan doc at the top.

### Chat only
Present both documents inline as formatted markdown. Offer to save them to a file if the user changes their mind.

## Tone & Style

Write like a thoughtful colleague, not a template generator. Skip filler phrases ("In order to achieve our organizational objectives..."). Be direct. If the plan contains a gap or a risky assumption, name it — that's more useful than a polished document that hides hard problems.

Plans should be long enough to be useful and short enough to be read. Most strategic plans should fit in one or two pages. Implementation plans should be specific but not so granular they need rewriting every day.

If you're unsure whether something belongs in the strategic plan or the implementation plan, a useful heuristic: strategic = *what* and *why*; implementation = *how* and *when*.
