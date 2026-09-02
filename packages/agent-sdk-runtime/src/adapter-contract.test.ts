import { describe, expect, test } from "bun:test"
import { resolvedModelFromConfigOptions, type AgentConfigOptions, type SupportsConfigOptions } from "./adapter-contract"

const modelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "claude-opus-5",
  selectOptions: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
  ],
}

describe("the config-options contract", () => {
  test("a harness reporting a current model resolves it with the harness's own label", () => {
    expect(resolvedModelFromConfigOptions([modelOption])).toEqual({ id: "claude-opus-5", name: "Claude Opus 5" })
  })

  test("a harness with no model option resolves no model", () => {
    const options = [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "code" }]
    expect(resolvedModelFromConfigOptions(options)).toBeUndefined()
  })

  test("a model option with no current value resolves no model", () => {
    const { currentValue: _currentValue, ...unset } = modelOption
    expect(resolvedModelFromConfigOptions([unset])).toBeUndefined()
  })

  test("a current value the harness published no label for resolves no model", () => {
    expect(resolvedModelFromConfigOptions([{ ...modelOption, currentValue: "claude-haiku-5" }])).toBeUndefined()
  })

  test("every config-options producer answers options plus an optional resolved model", async () => {
    const adapter: SupportsConfigOptions = {
      async probeConfigOptions() {
        return { options: [modelOption], resolvedModel: { id: "claude-opus-5", name: "Claude Opus 5" } }
      },
      peekConfigOptions() {
        return { options: [] }
      },
    }
    const probed: AgentConfigOptions = await adapter.probeConfigOptions("/work")
    expect(probed.resolvedModel).toEqual({ id: "claude-opus-5", name: "Claude Opus 5" })
    expect(await adapter.peekConfigOptions?.("/work")).toEqual({ options: [] })
  })
})
