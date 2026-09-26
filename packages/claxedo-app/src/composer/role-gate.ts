import { submitBlockCopy, type SubmitAuthorityBlock } from "./submit-block-reason"

export function promptDesignPlaceholder(input: {
  authorityBlock: SubmitAuthorityBlock | undefined
  mode: "normal" | "shell"
  shellPlaceholder: string
}) {
  if (input.authorityBlock) return submitBlockCopy(input.authorityBlock)
  if (input.mode === "shell") return input.shellPlaceholder
  return "Ask anything, / for commands, @ for context..."
}

export function harnessModesUnavailable(input: {
  isHarness: boolean
  readiness: string
  configError: boolean
  harness: string | undefined
}): string | undefined {
  if (!input.isHarness) return undefined
  if (input.readiness !== "error" && !input.configError) return undefined
  return `${input.harness ?? "This harness"} could not start, so its permission modes cannot be applied`
}
