export type PlanToolInput = {
  markdown?: string
  title?: string
}

/**
 * Claude's `ExitPlanMode` sends `{plan, planFilePath}`. The file lives in the
 * harness's own config directory, outside every workspace, so the markdown in
 * the call is the only copy a workspace-scoped reader can show.
 */
export function readPlanToolInput(input: Record<string, unknown> | undefined): PlanToolInput {
  const markdown = typeof input?.plan === "string" && input.plan.trim() ? input.plan : undefined
  const path = typeof input?.planFilePath === "string" ? input.planFilePath : undefined
  return { markdown, title: planTitle(markdown) ?? planFileStem(path) }
}

function planTitle(markdown: string | undefined) {
  const heading = markdown?.match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m)?.[1]?.trim()
  return heading || undefined
}

function planFileStem(path: string | undefined) {
  return path?.split(/[\\/]/).at(-1)?.replace(/\.(md|markdown)$/i, "") || undefined
}

export type PlanOpenDetail = {
  sessionId: string
  planId: string
  title?: string
  markdown: string
}

/** True when a host surface took the plan; an unhandled event leaves the row to expand inline. */
export function dispatchPlanOpen(target: EventTarget | null, detail: PlanOpenDetail) {
  if (!target) return false
  return !target.dispatchEvent(new CustomEvent("claxedo:open-plan", { bubbles: true, cancelable: true, detail }))
}
