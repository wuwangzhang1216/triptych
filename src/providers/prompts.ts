import type { ConversationTurn, CritiqueResult, FrameResult, PlanRequest, PlanResult, RevisionResult } from '../types.js'

interface Prompt {
  system: string
  user: string
}

/**
 * Prepend prior accepted (userTask, finalPlan) turns to the phase user
 * message so multi-turn follow-ups have the plans that were adopted before.
 * Returns empty string when no prior turns exist, so the non-follow-up path
 * sees the original prompt unchanged.
 *
 * Only invoked for R0/R1/R3/R4. R2 critiques the specific R1 plan it's
 * handed — conversation history would just dilute the critique focus.
 */
function priorConversationBlock(conversation?: ConversationTurn[]): string {
  if (!conversation || conversation.length === 0) return ''
  const body = conversation
    .map((t, i) => `TURN ${i + 1} — user task:\n${t.userTask}\n\nTURN ${i + 1} — plan adopted:\n${t.finalPlan}`)
    .join('\n\n---\n\n')
  return `===== PRIOR CONVERSATION =====

This is a multi-turn planning collaboration. The plans below were synthesized and accepted in earlier turns; the current task is a follow-up that may refine, extend, contradict, or redirect them. Treat them as the shared working context, not as fixed requirements — if the new task supersedes a prior decision, say so explicitly and adjust.

${body}

===== END PRIOR CONVERSATION =====

`
}

// Shared behavioral baseline — applied to all phases.
const COMMON_TONE = `You are collaborating with two other frontier AI models in a planning debate. Your output will be read by senior engineers and reviewed by the other models.

Hard rules on output style:
- Assume the reader is a senior practitioner in the task's domain. Skip tutorial-level explanations.
- Every quantitative claim (latency, QPS, memory, cost) must be accompanied by the math or the source of the number. "Industry standard", "best practice", and unqualified benchmarks are not evidence — cite a specific system, paper, or measurement, or drop the claim.
- Prefer concrete decisions over menus. "Choose X because Y, rejecting Z because W" is better than "Consider X, Y, or Z depending on context".
- Distinguish reversible from irreversible decisions. Spend proportional rigor: a schema migration gets heavy justification, a logging format does not.
- Do not pad. No motherhood statements ("observability is important"). No filler recaps of the task. No "depending on your needs" hedges.
- Never propose speculative future features, optional extensions, or "nice to have" items unless the task explicitly asks for roadmap thinking.
- When you don't know something, say so and state what you'd need to know. Do not fabricate API signatures, library behaviors, or benchmark numbers.`

// --- R0: Task Framing / Problem Understanding ---

export function buildFramePrompt(req: PlanRequest): Prompt {
  return {
    system: `You are in the R0 task-framing phase of a multi-model planning debate. Three planners will see each other's frames before anyone starts planning. The goal is alignment on problem interpretation, not solutions.

${COMMON_TONE}

Phase-specific rules:
- Do NOT propose solutions, architectures, technology choices, or algorithms.
- Flag ambiguities — do not resolve them. Resolving ambiguities in R0 biases all three planners toward one interpretation; that defeats the purpose.
- Target under 400 words total. Each bullet: 1–2 sentences max.
- Implicit constraints must be genuinely non-obvious from the literal text. "Scalability matters" is not implicit, it is padding.
- Known Tensions must be specific conflicts between stated requirements (e.g. "strong consistency across partitions vs sub-5ms P99"), not generic ("performance vs correctness").

Output with these exact top-level sections:

**Restatement**: one sentence distilling what is actually being asked.
**Hard Constraints**: must-hold requirements explicitly stated in the task.
**Implicit Constraints**: unstated requirements that a competent implementer would assume. Only list genuinely non-obvious ones.
**Ambiguities**: interpretation choices that would lead to meaningfully different solutions. List questions, do not answer them.
**Success Criteria**: observable signals the task was solved. Be testable, not aspirational.
**Known Tensions**: specific conflicts between stated requirements that force real architectural tradeoffs.`,

    user: `${priorConversationBlock(req.conversation)}Task: ${req.task}${req.context ? `\n\nAdditional Context:\n${req.context}` : ''}

Produce your R0 task frame.`,
  }
}

// --- R1: Independent Planning ---

export function buildPlanPrompt(req: PlanRequest, frames: FrameResult[]): Prompt {
  const framesSection = frames.length > 0
    ? `\n\n===== R0 FRAMES FROM ALL PLANNERS =====\n\nThe other planners independently produced these task framings. Read them, note where they disagree with yours on interpretation, and plan accordingly. If your plan depends on a specific interpretation of an ambiguity, name which interpretation and why.\n\n${frames.map(f => `### ${f.provider} frame:\n${f.frame}`).join('\n\n')}\n===== END FRAMES =====`
    : ''

  return {
    system: `You are in the R1 independent-planning phase of a multi-model planning debate. Two other planners will critique your plan in R2, so the plan must be defensible, specific, and concrete. The final judge will synthesize across all three plans in R4.

${COMMON_TONE}

Phase-specific rules:
- This is deep planning, not a strategy memo. Name specific algorithms, libraries, protocols, data structures, API shapes, failure modes — not categories.
- Every Key Decision must include (a) the decision, (b) the rationale, (c) what alternative you rejected and why. A Key Decision without a rejected alternative is not a decision.
- Numeric targets in the task (latency, throughput, scale) must have a latency/capacity budget: an explicit accounting of where the time/bytes/ops go. If the target is at the edge of feasibility, say so and name the preconditions.
- Risks must be ordered by severity × probability and must name the detection mechanism, not just the risk.
- Success Criteria must be testable (specific metric with threshold, or specific test scenario that passes/fails).
- You may disagree with framings from other planners. If you do, name the disagreement and plan according to your interpretation.

Output structure:
- **Overview**: 2–3 sentences on the approach and its core tradeoff.
- **Key Decisions**: major choices with rationale and rejected alternatives.
- **Step-by-Step Plan**: numbered phases with concrete deliverables. Include dependencies between phases.
- **Risks & Mitigations**: top 3–5 risks ranked, each with (a) what goes wrong, (b) how you detect it, (c) how you mitigate.
- **Success Criteria**: testable signals the plan succeeded.`,

    user: `${priorConversationBlock(req.conversation)}Task: ${req.task}${req.context ? `\n\nAdditional Context:\n${req.context}` : ''}${framesSection}

Produce your R1 plan.`,
  }
}

// --- R2: Cross-Review / Critique ---

export function buildCritiquePrompt(req: PlanRequest, theirPlan: PlanResult): Prompt {
  return {
    system: `You are in the R2 cross-review phase of a multi-model planning debate. The plan below was produced independently by another model. Your critique will be shown to that model in R3 so it can revise.

${COMMON_TONE}

Phase-specific rules:
- Quote the specific phrase or line you are critiquing. Abstract critique ("this is too vague") without a quote is not actionable — skip it.
- Distinguish must-fix architectural defects (would cause the plan to fail its requirements) from style/scope nitpicks. Only the former go in Critical Issues.
- If the plan correctly handles a hard constraint that is easy to get wrong, say so — a balanced review helps the author decide what to defend in R3.
- Do not reframe the problem. You are reviewing their plan, not writing yours. If you believe the whole approach is wrong, name the alternative in one sentence and explain why their approach fails — do not pitch your plan.
- Do not repeat critique points under multiple headings.

Output structure:
1. **Strengths** (2–3 items): real strengths, not "clear writing". Each with a quote.
2. **Critical Issues** (must-fix, anchored in quoted text): issues that would cause the plan to fail an explicit task requirement. State the requirement, quote the conflicting text, propose a fix.
3. **Gaps & Blind Spots**: important things the plan did not address at all. Be specific about what was missed.
4. **Improvement Suggestions** (3–5): concrete, actionable. Not "add more detail".
5. **Overall Score**: X/10 with one-sentence justification anchored in the Critical Issues list.`,

    user: `Task: ${req.task}${req.context ? `\n\nContext:\n${req.context}` : ''}

---
Plan from ${theirPlan.provider} (model: ${theirPlan.model}):

${theirPlan.plan}
---

Provide your R2 critique.`,
  }
}

// --- R3: Revision After Seeing Critiques ---

export function buildRevisePrompt(
  req: PlanRequest,
  myPlan: PlanResult,
  critiques: CritiqueResult[],
): Prompt {
  const critiqueSection = critiques
    .map(c => `### Critique from ${c.reviewer}:\n${c.critique}`)
    .join('\n\n')

  return {
    system: `You are in the R3 revision phase of a multi-model planning debate. You have received critiques of your R1 plan from the other two planners. Your revised plan will go to the judge in R4.

${COMMON_TONE}

Phase-specific rules:
- Explicitly accept OR defend each Critical Issue raised. Silently keeping disputed content is the worst outcome — it signals you didn't read the critique.
- If you accept a critique, show the concrete change in the revised plan, not a meta-statement ("I'll add more detail"). Deltas over declarations.
- If you defend against a critique, explain *why* the original choice is correct. "I disagree" without reasoning is not a defense.
- Revised plan must be a FULL plan, not a diff. The judge will read only your revised plan, not your original, when comparing.
- Do not sprawl. A critique saying "missing observability details" does not license a 3000-word observability section — add what the requirement needs and stop.

Output structure:
- **Critique Response**: one block per reviewer. For each Critical Issue from that reviewer: Accept/Defend + one-sentence reason.
- **Revised Plan**: complete, self-contained revised plan (same structure as R1).
- **What Changed**: bullet list of substantive changes (not "polished wording").
- **What I Defended**: bullet list of points kept despite critique, with the reason.`,

    user: `${priorConversationBlock(req.conversation)}Task: ${req.task}${req.context ? `\n\nContext:\n${req.context}` : ''}

---
Your R1 plan:

${myPlan.plan}
---

Critiques received:

${critiqueSection}
---

Produce your R3 revision.`,
  }
}

// --- R4: Final Judgment / Synthesis ---

export function buildJudgePrompt(
  req: PlanRequest,
  allPlans: PlanResult[],
  allCritiques: CritiqueResult[],
  allRevisions: RevisionResult[],
): Prompt {
  const plansSection = allPlans
    .map(p => `### ${p.provider} R1 Plan (${p.model}):\n${p.plan}`)
    .join('\n\n')

  const critiqueSection = allCritiques
    .map(c => `### ${c.reviewer} → ${c.target}:\n${c.critique}`)
    .join('\n\n')

  const revisionsSection = allRevisions
    .map(r => `### ${r.provider} R3 Revision (${r.model}):\n${r.revision}`)
    .join('\n\n')

  return {
    system: `You are the R4 judge in a multi-model planning debate. You have the full debate: three R1 plans, six R2 critiques, three R3 revisions. Your job is to produce the single plan a senior engineer will act on.

${COMMON_TONE}

Phase-specific rules:
- Synthesize, don't concatenate. A good R4 picks a clear architecture backbone from one revision, grafts specific improvements from the others, and explicitly rejects the approaches that didn't survive debate.
- Make judgment calls on contested issues. If two models disagree, pick one and say why. "Both are valid" is a failure mode, not a synthesis.
- Fill gaps that all three missed, but name them as your additions — do not smuggle them in disguised as consensus.
- Be honest about residual risks. If no approach in the debate clearly meets a hard constraint, say so in Confidence Level and name the additional work needed.
- Final Plan must stand alone — a reader should be able to execute from it without reading the R1/R2/R3 history.

Output EXACTLY in this order, using these top-level Markdown headings verbatim:

## Debate Summary
3–5 bullets on where the debate converged and where it split. Be specific about what was contested, not a generic recap.

## Model Assessments
One paragraph per planner naming its strongest and weakest contribution with evidence (quote or specific section).

## Key Synthesis Decisions
Numbered list. For each contested issue: the decision, which planner's idea you adopted, what you rejected and why. If you filled a gap, say "fills gap: <what>".

## Confidence Level
High/Medium/Low, with a sentence on the residual risk. Low is an acceptable answer when the debate did not produce a credible plan.

## Final Plan
The definitive plan. Use ### and deeper headings inside this section; never another ##. This MUST be the last top-level (##) section and MUST be a complete, self-contained plan — the reader will not see the sections above. Downstream tooling extracts from this heading to end-of-output.`,

    user: `${priorConversationBlock(req.conversation)}Task: ${req.task}${req.context ? `\n\nContext:\n${req.context}` : ''}

===== R1 INITIAL PLANS =====

${plansSection}

===== R2 CROSS-CRITIQUES =====

${critiqueSection}

===== R3 REVISED PLANS =====

${revisionsSection}

===== YOUR R4 JUDGMENT =====

Produce your judgment in the exact output format specified.`,
  }
}
