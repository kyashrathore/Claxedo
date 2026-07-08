import { describe, expect, test } from "bun:test"
import path from "node:path"
import { walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("composer mode guard", () => {
  test("keeps owned PromptInput mount sites on explicit ComposerMode", () => {
    const offenders = walkProdSources(appRoot).flatMap((file) => {
      if (file.path === "session-client/composer/composer.tsx") return []
      if (!/<PromptInput\b/.test(file.text)) return []
      if (/<PromptInput[\s\S]*?\bmode=/.test(file.text)) return []
      return [`${file.path}: pass explicit ComposerMode via the mode prop`]
    })

    expect(offenders).toEqual([])
  })

  test("keeps submit admission on the explicit ComposerMode input", async () => {
    const submit = await Bun.file(path.join(appRoot, "src/components/prompt-input/submit.ts")).text()
    const machine = await Bun.file(path.join(appRoot, "src/session-client/commands/prompt-machine.ts")).text()

    expect(submit).toContain("admitPromptSubmission({")
    expect(submit).toContain("mode: input.composerMode()")
    expect(`${submit}\n${machine}`).not.toContain("admitPromptSubmissionFromLegacyProps")
  })

  test("does not keep the old legacy composer-mode adapter alive", async () => {
    const source = await Bun.file(path.join(appRoot, "src/session-client/composer/mode.ts")).text()

    expect(source).not.toMatch(/composerModeFromLegacyProps|legacySessionId|LegacyComposerModeProps/)
  })
})
