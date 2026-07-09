import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const setHarnessCalls: Array<{ scope: string; type: string }> = []
const setModelCalls: Array<{ scope: string; model: string }> = []
const hydrateCalls: Array<{ scope: string; directory?: string; sessionId?: string }> = []
let readiness = "ready"
let models: Array<{ id: string; name: string }> = []
let selectedModel = ""
let configError: string | undefined
let optionsStale = false
let optionsLoading = false

vi.mock("../../pane/store/pane-preferences", () => ({
  panePreferenceScope: () => "test-scope",
}))

// Stub Select to expose trigger + option buttons in the DOM
vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: any) => {
    const groups = (props.options as string[]).reduce((result, opt) => {
      const group = props.groupBy?.(opt) ?? ""
      result.set(group, [...(result.get(group) ?? []), opt])
      return result
    }, new Map<string, string[]>())
    return (
      <div data-testid="select" data-disabled={props.disabled ? "true" : "false"}>
        <button
          data-testid="select-trigger"
          disabled={props.disabled}
        >
          {props.label?.(props.current) ?? props.current}
        </button>
        {[...groups.entries()].map(([group, options]) => (
          <div data-testid={`select-group-${group}`}>
            <span>{group}</span>
            {options.map((opt: string) => (
              <button
                data-testid={`select-option-${opt}`}
                onClick={() => props.onSelect?.(opt)}
              >
                {props.label?.(opt) ?? opt}
              </button>
            ))}
          </div>
        ))}
      </div>
    )
  },
}))

vi.mock("@claxedo/components/dialog-select-model", () => ({
  ModelSelectorPopover: (props: any) => {
    const items = props.model?.list?.() ?? []
    return (
      <div data-testid="model-selector" data-disabled={props.triggerProps?.disabled ? "true" : "false"}>
        <div data-testid="model-trigger-content">{props.children}</div>
        {items.map((item: any) => (
          <button
            data-testid={`model-option-${item.id}`}
            onClick={() => props.model?.set?.({ modelID: item.id, providerID: item.provider?.id })}
          >
            {item.name}
          </button>
        ))}
      </div>
    )
  },
}))

vi.mock("@opencode-ai/ui/v2/tooltip-v2", () => ({
  TooltipV2: (props: any) => (
    <span data-testid="tooltip-v2" data-value={props.value}>
      {props.children}
    </span>
  ),
}))

import { AgentHarnessSelector } from "./agent-harness-selector"
import type { HarnessSelectionController } from "@claxedo/session-client/harness/controller"

function harnessController(): HarnessSelectionController {
  return {
    read: () => ({
      harness: "claude-acp",
      readiness: readiness as ReturnType<HarnessSelectionController["read"]>["readiness"],
      isHarnessMode: true,
      models,
      selectedModel,
      configError,
      optionsStale,
      optionsLoading,
    }),
    hydrate: (scope: string, input?: { directory?: string; sessionId?: string }) => {
      hydrateCalls.push({ scope, directory: input?.directory, sessionId: input?.sessionId })
    },
    setHarness: (scope: string, type: string) => {
      setHarnessCalls.push({ scope, type })
    },
    setModel: (scope: string, model: string) => {
      setModelCalls.push({ scope, model })
      selectedModel = model
    },
  }
}

function TestAgentHarnessSelector(props: Omit<Parameters<typeof AgentHarnessSelector>[0], "harnessController">) {
  return <AgentHarnessSelector harnessController={harnessController()} {...props} />
}

afterEach(() => {
  cleanup()
  setHarnessCalls.length = 0
  setModelCalls.length = 0
  hydrateCalls.length = 0
})

beforeEach(() => {
  readiness = "ready"
  models = []
  selectedModel = ""
  configError = undefined
  optionsStale = false
  optionsLoading = false
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentHarnessSelector — sessionLocked guard", () => {
  test("trigger is enabled when sessionLocked is false (new session)", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(false)
  })

  test("trigger is disabled when sessionLocked is true (existing session)", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(true)
  })

  test("trigger is disabled while polling", () => {
    readiness = "polling"
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(true)
  })

  test("select data-disabled attribute reflects lock state", () => {
    const { container: unlocked } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    expect(unlocked.querySelector("[data-testid='select']")!.getAttribute("data-disabled")).toBe("false")
    cleanup()

    const { container: locked } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)
    expect(locked.querySelector("[data-testid='select']")!.getAttribute("data-disabled")).toBe("true")
  })

  test("clicking an option calls setHarness when unlocked", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-codex-acp']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toHaveLength(1)
    expect(setHarnessCalls[0].type).toBe("codex-acp")
  })

  test("clicking the current harness does not call setHarness", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-claude-acp']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toHaveLength(0)
  })

  test("clicking an option does NOT call setHarness when locked", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)
    const option = container.querySelector("[data-testid='select-option-codex-acp']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toHaveLength(0)
  })

  test("switching from opencode to claude-acp is blocked when locked", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)

    for (const runner of ["claude-acp", "codex-acp", "cursor-acp", "claude-sdk", "codex-app-server", "cursor-sdk", "pi", "opencode"]) {
      const opt = container.querySelector(`[data-testid='select-option-${runner}']`) as HTMLButtonElement
      fireEvent.click(opt)
    }
    expect(setHarnessCalls).toHaveLength(0)
  })

  test("only starts one runner switch while a switch is in flight", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    for (const runner of ["claude-acp", "codex-acp", "cursor-acp", "claude-sdk", "codex-app-server", "cursor-sdk", "pi", "opencode"]) {
      const opt = container.querySelector(`[data-testid='select-option-${runner}']`) as HTMLButtonElement
      fireEvent.click(opt)
    }
    expect(setHarnessCalls).toEqual([{ scope: "test-scope", type: "codex-acp" }])
  })

  test("groups harness choices by ACP, native SDK, and direct runners", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(container.querySelector("[data-testid='select-group-ACP']")?.textContent).toContain("Claude")
    expect(container.querySelector("[data-testid='select-group-ACP']")?.textContent).toContain("Codex")
    expect(container.querySelector("[data-testid='select-group-ACP']")?.textContent).toContain("Cursor")
    expect(container.querySelector("[data-testid='select-group-Native SDK']")?.textContent).toContain("Claude")
    expect(container.querySelector("[data-testid='select-group-Native SDK']")?.textContent).toContain("Codex")
    expect(container.querySelector("[data-testid='select-group-Native SDK']")?.textContent).toContain("Cursor")
    expect(container.querySelector("[data-testid='select-group-Direct']")?.textContent).toContain("Pi")
    expect(container.querySelector("[data-testid='select-group-Direct']")?.textContent).toContain("OpenCode")
  })

  test("renders the selected model when ACP model options are available", () => {
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(container.querySelector("[data-testid='model-selector']")).not.toBeNull()
    expect(container.textContent).toContain("Default (recommended)")
  })

  test("selecting a runner model stores the selected row id and updates the label", () => {
    models = [
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      { id: "claude-opus-4-6", name: "Opus 4.6" },
    ]
    selectedModel = "claude-sonnet-4-6"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    fireEvent.click(container.querySelector("[data-testid='model-option-claude-opus-4-6']") as HTMLButtonElement)

    expect(setModelCalls).toEqual([{ scope: "test-scope", model: "claude-opus-4-6" }])
    expect(container.textContent).toContain("Opus 4.6")
  })

  test("selecting the current runner model is a no-op command", () => {
    models = [
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      { id: "claude-opus-4-6", name: "Opus 4.6" },
    ]
    selectedModel = "claude-sonnet-4-6"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    fireEvent.click(container.querySelector("[data-testid='model-option-claude-sonnet-4-6']") as HTMLButtonElement)

    expect(setModelCalls).toEqual([])
    expect(container.textContent).toContain("Sonnet 4.6")
  })

  test("shows a selected id instead of Select model when options refresh without that row", () => {
    models = [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }]
    selectedModel = "claude-opus-4-6"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(container.textContent).toContain("claude-opus-4-6")
    expect(container.textContent).not.toContain("Select model")
  })

  test("keeps an explicit model slot while options load", () => {
    optionsLoading = true

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    expect(container.textContent).toContain("Loading models")
  })

  test("shows loading instead of a default sentinel while options are in flight", () => {
    optionsLoading = true
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(container.textContent).toContain("Loading models")
  })

  test("surfaces runner config errors through the issue dot tooltip", () => {
    configError = "Authentication required. Please run 'agent login' first."
    optionsStale = true
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const issue = container.querySelector("[aria-label=\"Authentication required. Please run 'agent login' first.\"]") as HTMLElement

    expect(issue).not.toBeNull()
    expect(issue.getAttribute("title")).toBe("Authentication required. Please run 'agent login' first.")
    expect(container.querySelector("[data-testid='tooltip-v2']")?.getAttribute("data-value")).toBe(
      "Authentication required. Please run 'agent login' first.",
    )
    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.textContent).toContain("Unavailable")
    expect(trigger?.textContent).not.toContain("Default (recommended)")
  })

  test("surfaces Cursor SDK auth requirements through the issue dot", () => {
    configError = "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login."
    optionsStale = true
    models = []

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const issue = container.querySelector("[aria-label='Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login.']") as HTMLElement

    expect(issue).not.toBeNull()
    expect(issue.getAttribute("title")).toBe(
      "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login.",
    )
    expect(container.querySelector("[data-testid='tooltip-v2']")?.getAttribute("data-value")).toBe(
      "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login.",
    )
  })

  test("shows unavailable when option discovery fails", () => {
    configError = "ACP connection closed"
    optionsStale = true
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.textContent).toContain("Unavailable")
    expect(trigger?.textContent).not.toContain("Default (recommended)")
  })

  test("keeps an explicit unavailable model slot when runner config fails", () => {
    readiness = "error"
    configError = "Failed to load model options"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    expect(container.textContent).toContain("Unavailable")
  })

  test("keeps the selected model label when runner config fails after model resolution", () => {
    readiness = "error"
    configError = "Failed to initialize runner"
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    expect(container.textContent).toContain("Default (recommended)")
    expect(container.textContent).toContain("Unavailable")
  })

  test("hydrates runner options from explicit pane identity", async () => {
    render(() => (
      <TestAgentHarnessSelector
        directory="/repo/main"
        sessionId="ses_1"
        surfaceId="surface_1"
        sessionLocked={false}
      />
    ))

    await waitFor(() => {
      expect(hydrateCalls).toEqual([{ scope: "test-scope", directory: "/repo/main", sessionId: "ses_1" }])
    })
  })

  test("does not hydrate inactive pane identity", () => {
    render(() => (
      <TestAgentHarnessSelector
        active={false}
        directory="/repo/main"
        sessionId="ses_1"
        sessionLocked={false}
      />
    ))

    expect(hydrateCalls).toEqual([])
  })
})
