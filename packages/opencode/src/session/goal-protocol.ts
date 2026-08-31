/**
 * The first-party Goal executor protocol.
 *
 * A first-party Goal controller drives its own loop: it prompts the worker,
 * asks an INDEPENDENT evaluator whether the objective is met, and folds the
 * verdict back into the Goal snapshot. Every one of those steps is a contract
 * between a prompt and a parser, so the wording, the evaluator's JSON shape,
 * and the status transition all belong to one owner rather than to each
 * controller that happens to implement the loop.
 *
 * This engine and `@claxedo/agent-sdk-runtime`'s Pi controller both run that
 * loop, and neither package depends on the other, so `GOAL_PROMPT_TEXT` is
 * mirrored in both. `test/session/goal-protocol.test.ts` pins the two copies to
 * the same literals; changing one without the other fails there.
 */

export const GOAL_PROMPT_TEXT = {
  initialObjectiveLead: "Work autonomously toward this Goal:",
  initialGuidance: "Use tools as needed and report concrete evidence. An independent evaluator decides completion.",
  continuationObjectiveLead: "Continue working toward the Goal:",
  continuationEvaluatorLead: "Independent evaluator:",
  continuationGuidance: "Address the missing evidence and continue autonomously.",
  missingEvaluatorReason: "More evidence is required",
  evaluatorSystem: [
    "You are an independent completion evaluator.",
    "Judge whether the supplied work result satisfies the objective.",
    'Reply with exactly one JSON object: {"met":boolean,"reason":string}.',
    "Do not use tools, perform work, or assume missing evidence.",
  ],
  evaluatorObjectiveLabel: "OBJECTIVE:",
  evaluatorWorkLabel: "LATEST WORK RESULT:",
  evaluatorEmptyWork: "(no visible result)",
  noJsonResult: "Goal evaluator returned no JSON result",
  invalidResult: "Goal evaluator returned an invalid result",
} as const

/** The worker prompt that opens a Goal. */
export function goalInitialPrompt(objective: string) {
  return [
    `${GOAL_PROMPT_TEXT.initialObjectiveLead} ${objective}`,
    GOAL_PROMPT_TEXT.initialGuidance,
  ].join("\n\n")
}

/** The worker prompt for an iteration the evaluator has refused. */
export function goalContinuationPrompt(input: { objective: string; reason?: string | null }) {
  return [
    `${GOAL_PROMPT_TEXT.continuationObjectiveLead} ${input.objective}`,
    `${GOAL_PROMPT_TEXT.continuationEvaluatorLead} ${input.reason ?? GOAL_PROMPT_TEXT.missingEvaluatorReason}`,
    GOAL_PROMPT_TEXT.continuationGuidance,
  ].join("\n\n")
}

/** The evaluator's only view of the run: the objective and the latest work. */
export function goalEvaluatorRequest(input: { objective: string; work: string }) {
  return [
    GOAL_PROMPT_TEXT.evaluatorObjectiveLabel,
    input.objective,
    "",
    GOAL_PROMPT_TEXT.evaluatorWorkLabel,
    input.work || GOAL_PROMPT_TEXT.evaluatorEmptyWork,
  ].join("\n")
}

export type GoalEvaluation = {
  met: boolean
  reason: string
}

/**
 * Read the evaluator's verdict out of a free-form completion.
 *
 * `evaluator` names the controller in the thrown message so an operator can
 * tell which Goal executor produced an unusable verdict.
 */
export function parseGoalEvaluation(response: string, evaluator: string): GoalEvaluation {
  const object = response.match(/\{[\s\S]*\}/)?.[0]
  if (!object) throw new Error(`${evaluator} ${GOAL_PROMPT_TEXT.noJsonResult}`)
  const parsed = JSON.parse(object) as { met?: unknown; reason?: unknown }
  if (typeof parsed.met !== "boolean" || typeof parsed.reason !== "string") {
    throw new Error(`${evaluator} ${GOAL_PROMPT_TEXT.invalidResult}`)
  }
  return { met: parsed.met, reason: parsed.reason }
}

/**
 * The status transition a verdict implies. A met objective completes the Goal;
 * anything else keeps it active for the next iteration and carries the
 * evaluator's reason forward as the continuation prompt's evidence.
 */
export function goalEvaluationProgress(input: {
  evaluation: GoalEvaluation
  iteration: number
  now?: number
}): { status: "active" | "complete"; updatedAt: number; iteration: number; lastReason: string } {
  return {
    status: input.evaluation.met ? "complete" : "active",
    updatedAt: input.now ?? Date.now(),
    iteration: input.iteration,
    lastReason: input.evaluation.reason,
  }
}
