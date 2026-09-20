import type { Placement } from "@/platform/runtime/placement"
import { can } from "@/platform/auth/role"
import { submitBlockCopy, type SubmitAuthorityBlock } from "./submit-block-reason"

export function submitBlockedByRole(placement: Placement | undefined) {
  if (!placement) return false
  return !can("mutate.session", placement)
}

/**
 * Who answers "may this composer send".
 *
 * A session share admits someone the workspace ranks `viewer` or does not rank
 * at all, so the workspace role cannot answer for a session that exists: the
 * runtime reports the session authority's own answer with that session's
 * capabilities, and it decides. Only a draft, which names no session yet,
 * falls back to the workspace — a session is created against the workspace,
 * and a share carries no standing to create one.
 */
export function submitAuthorityBlock(input: {
  sessionPromptAdmitted: boolean | undefined
  workspacePlacement: Placement | undefined
}): SubmitAuthorityBlock | undefined {
  if (input.sessionPromptAdmitted !== undefined) {
    return input.sessionPromptAdmitted ? undefined : "session-share"
  }
  return submitBlockedByRole(input.workspacePlacement) ? "workspace-role" : undefined
}

export function promptDesignPlaceholder(input: {
  authorityBlock: SubmitAuthorityBlock | undefined
  mode: "normal" | "shell"
  shellPlaceholder: string
}) {
  if (input.authorityBlock) return submitBlockCopy(input.authorityBlock)
  if (input.mode === "shell") return input.shellPlaceholder
  return "Ask anything, / for commands, @ for context..."
}

/**
 * Why the permission picker must not list this harness's modes.
 *
 * The draft mode list is a RECORDED table rather than something the agent said,
 * so it answers just as confidently for a harness that failed to start as for
 * one that is running. That produced a picker offering "Codex (ACP) · Agent" one
 * line under "Codex could not start" — worse than showing nothing, because the
 * rows read as the agent's own report and choosing one looks like setting a
 * policy that can never apply, there being no agent to apply it to.
 *
 * `harnessReadiness` already reaches a terminal "error"; the composer simply
 * never consumed it here, only "polling".
 */
export function harnessModesUnavailable(input: {
  isHarness: boolean
  readiness: string
  /**
   * A bad config counts as "cannot start" even while readiness still reads
   * ready or polling — which is exactly the case that slipped through first:
   * codex's config.toml was rejected, the composer's Send button already said
   * "The agent isn't running", and the picker went on listing modes because it
   * was only consulting readiness. `submitBlockReason` gates on both, so this
   * gates on both.
   */
  configError: boolean
  harness: string | undefined
}): string | undefined {
  if (!input.isHarness) return undefined
  if (input.readiness !== "error" && !input.configError) return undefined
  return `${input.harness ?? "This harness"} could not start, so its permission modes cannot be applied`
}
