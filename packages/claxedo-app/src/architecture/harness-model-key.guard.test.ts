import { describe, expect, test } from "bun:test"
import path from "node:path"
import { walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

function source(file: string) {
  const hit = walkProdSources(appRoot).find((item) => item.path === file)
  expect(hit, `${file} should be a production source file`).toBeDefined()
  return hit!.text
}

describe("harness submit model key guard", () => {
  test("keeps harness submit on the canonical ModelKey boundary", () => {
    const offenders = walkProdSources(appRoot).flatMap((file) => {
      if (!/harnessModelForSubmit|harnessSubmitModel|runnerSubmitModel|\bharnessModel\s*:/.test(file.text)) return []
      return [`${file.path}: harness submit must use ModelKey via harnessModelKeyForSubmit/harnessModelKey`]
    })

    expect(offenders).toEqual([])
  })

  test("pins the current harness ModelKey path", () => {
    const productionFiles = walkProdSources(appRoot).map((item) => item.path)
    const harnessConfigStore = source("claxedo-ui/context/harness-config-store.ts")
    const harnessController = source("session-client/harness/controller.ts")
    const submitTypes = source("session/submit/types.ts")
    const submit = source("components/prompt-input/submit.ts")
    const resolve = source("session/submit/resolve.ts")

    expect(productionFiles).not.toContain("claxedo-ui/context/harness-config.ts")
    expect(harnessConfigStore).toMatch(/harnessModelKeyForSubmit/)
    expect(harnessConfigStore).not.toMatch(/harnessModelForSubmit/)
    expect(harnessController).toMatch(/modelKeyForSubmit/)
    expect(harnessController).toMatch(/harnessModelKeyForSubmit/)

    expect(submitTypes).toMatch(/import type \{ ModelKey \} from "\.\.\/\.\.\/session-client\/composer\/model-strategy"/)
    expect(submitTypes).toMatch(/harnessModelKey\?: ModelKey/)
    expect(submitTypes).not.toMatch(/harnessModel\?: SubmitModel/)

    expect(submit).toMatch(/harnessModelKey:\s*selectedHarnessMode\(scope\)\s*\?\s*harnessController\.modelKeyForSubmit\(scope\)\s*:\s*undefined/)
    expect(submit).toMatch(/input\.harnessController \?\? createHarnessSubmitController\(undefined\)/)
    expect(submit).not.toMatch(/useHarnessConfig/)
    expect(submit).not.toMatch(/context\/harness-config/)
    expect(submit).not.toMatch(/\bharnessModel\s*:/)
    expect(submit).not.toMatch(/harnessModelForSubmit/)

    expect(resolve).toMatch(/input\.harnessModelKey/)
    expect(resolve).not.toMatch(/input\.harnessModel\b/)
  })

  test("keeps the harness selector off the harness-config context", () => {
    const selector = source("claxedo-ui/components/agent-harness-selector.tsx")

    expect(selector).toMatch(/harnessController: HarnessSelectionController/)
    expect(selector).not.toMatch(/useHarnessConfig/)
    expect(selector).not.toMatch(/context\/harness-config/)
  })

  test("keeps PromptInput on injected harness controllers", () => {
    const input = source("session-client/composer/composer.tsx")
    const inputProps = source("session-client/composer/prompt-input-props.ts")

    expect(inputProps).toMatch(/harnessSubmitController\?: HarnessSubmitController/)
    expect(inputProps).toMatch(/harnessSelectionController\?: HarnessSelectionController/)
    expect(input).toMatch(/type \{ PromptInputProps \}/)
    expect(input).toMatch(/harnessController,\s*\n\s*\}\)/)
    expect(input).not.toMatch(/useHarnessConfig/)
    expect(input).not.toMatch(/context\/harness-config/)
  })

  test("keeps prompt harness wiring off the legacy harness context", () => {
    const adapter = source("components/prompt-input/harness-controller.ts")
    const shell = source("shell/app-shell.tsx")

    expect(adapter).toMatch(/PromptHarnessControllersProvider/)
    expect(adapter).toMatch(/createHarnessConfigStore/)
    expect(adapter).not.toMatch(/useHarnessConfig/)
    expect(adapter).not.toMatch(/HarnessConfigProvider/)

    expect(shell).toMatch(/PromptHarnessControllersProvider/)
    expect(shell).not.toMatch(/HarnessConfigProvider/)
    expect(shell).not.toMatch(/useHarnessConfig/)
  })
})
