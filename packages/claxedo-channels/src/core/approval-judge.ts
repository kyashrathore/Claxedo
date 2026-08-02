import type { ApprovalRequest } from "../envelope"

/**
 * What the judge is asked to decide.
 *
 * NOT "should this tool run" — that is the human's call. The judge only reads
 * an incoming reply in the context of the prompt it appears to answer and says
 * which of the three things the human meant: yes, no, or unclear.
 */
export type ApprovalJudgeInput = {
  /** The pending prompt this reply might be answering. */
  request: ApprovalRequest
  /** The human's raw reply text. */
  text: string
  /** Prior turns in the thread, oldest first, for pronoun/ellipsis resolution. */
  history?: readonly ApprovalJudgeTurn[]
}

export type ApprovalJudgeTurn = {
  role: "user" | "assistant"
  text: string
}

/**
 * `"unclear"` is a first-class outcome, not a failure. A reply the judge cannot
 * confidently read must re-ask rather than guess, because guessing wrong on
 * `"approved"` executes something irreversible.
 */
export type ApprovalJudgeVerdict =
  | { decision: "approved" | "denied" }
  | { decision: "unclear"; question?: string }

export type ApprovalJudge = (input: ApprovalJudgeInput) => Promise<ApprovalJudgeVerdict>

export const APPROVAL_JUDGE_TIMEOUT_MS = 10_000

export const APPROVAL_UNCLEAR_REPLY = "Sorry, I couldn't tell whether that was a yes or a no. Reply approve or deny to answer the pending request."

/**
 * Run the judge fail-safe: any timeout, throw, or malformed verdict resolves to
 * `"unclear"`, never to a decision. A judge that is slow or broken must degrade
 * into asking the human again — never into approving on their behalf.
 */
export async function runApprovalJudge(input: {
  judge: ApprovalJudge
  request: ApprovalRequest
  text: string
  history?: readonly ApprovalJudgeTurn[]
  timeoutMs?: number
}): Promise<ApprovalJudgeVerdict> {
  const timeoutMs = input.timeoutMs ?? APPROVAL_JUDGE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const verdict = await Promise.race([
      input.judge({
        request: input.request,
        text: input.text,
        ...(input.history ? { history: input.history } : {}),
      }),
      new Promise<ApprovalJudgeVerdict>((resolve) => {
        timer = setTimeout(() => resolve({ decision: "unclear" }), timeoutMs)
      }),
    ])
    if (verdict?.decision === "approved" || verdict?.decision === "denied") return { decision: verdict.decision }
    if (verdict?.decision === "unclear") {
      return { decision: "unclear", ...(verdict.question ? { question: verdict.question } : {}) }
    }
    return { decision: "unclear" }
  } catch {
    return { decision: "unclear" }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
