import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library"

type ConnectDialogProps = {
  provider: string
  harness: string
  onConnected: () => void | Promise<void>
}

type PiProvider = {
  id: string
  name: string
  models: Record<string, { id: string; name: string }>
}

const dialogState = vi.hoisted(() => ({
  show: vi.fn(),
  connectProps: undefined as ConnectDialogProps | undefined,
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const setHarnessCalls: Array<{ scope: string; type: string }> = []
const setModelCalls: Array<{ scope: string; model: { providerID: string; modelID: string } }> = []
const hydrateCalls: Array<{ scope: string; directory?: string; sessionId?: string }> = []
const resolveDefaultCalls: unknown[] = []
let readiness = "ready"
let harnessType = "claude-acp"
let models: Array<{ id: string; name: string }> = []
let selectedModel = ""
let selectedModelProvider: string | undefined
let configError: string | undefined
let optionsStale = false
let optionsLoading = false
let piLoading = false
let piError: string | undefined
let piConnected: string[] = []
let piProviders = new Map<string, PiProvider>()
let piRefreshCalls = 0
let piDefaults: Record<string, string> = {}
let draftDefaultState: "ready" | "choose-model" | "saved-model-unavailable" | "unsupported-placement" | undefined = "ready"
let draftDefaultLabels: { provider?: string; model?: string } | undefined

vi.mock("@/features/session/app-ports", () => ({
  useProviders: () => ({
    all: () => piProviders,
    connected: () => piConnected.flatMap((id) => {
      const provider = piProviders.get(id)
      return provider ? [provider] : []
    }),
    loading: () => piLoading,
    error: () => piError,
    refresh: async () => { piRefreshCalls += 1 },
    default: () => piDefaults,
  }),
  loadConnectProviderDialog: async () => ({
    DialogConnectProvider: (props: ConnectDialogProps) => {
      dialogState.connectProps = props
      return null
    },
  }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (render: () => unknown) => {
      dialogState.show(render)
      render()
    },
    close: vi.fn(),
  }),
}))

vi.mock("@/features/session/preferences/pane", () => ({
  panePreferenceScope: () => "test-scope",
  // store-state → store-policy re-exports these at module load; the live
  // harnessStatusPatch assertion below doesn't exercise them, so stubs suffice.
  isDraftPaneScope: (scope: string) => scope.startsWith("draft:"),
  initialPaneHarness: (_scope: string, saved?: string, legacy?: string | null) => saved ?? legacy ?? undefined,
  initialPaneValue: (_scope: string, saved?: string, legacy?: string | null) => saved ?? legacy ?? "",
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
              <>
                {/* Choosing an option is only reachable with the menu open, so
                    faithfully fire onOpenChange(true) first (real Kobalte does). */}
                <button
                  data-testid={`select-option-${opt}`}
                  onClick={() => {
                    props.onOpenChange?.(true)
                    props.onSelect?.(opt)
                  }}
                >
                  {props.label?.(opt) ?? opt}
                </button>
                {/* Simulates the trigger's typeahead-while-closed: a value change
                    WITHOUT the menu ever opening. */}
                <button
                  data-testid={`select-typeahead-${opt}`}
                  onClick={() => props.onSelect?.(opt)}
                >
                  {props.label?.(opt) ?? opt}
                </button>
              </>
            ))}
          </div>
        ))}
      </div>
    )
  },
}))

vi.mock("@/features/session/ui/model/select-model", () => ({
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
import { harnessStatusPatch } from "@/features/session/harness/store-state"
import type { HarnessSelectionController } from "@/features/session/harness/controller"

function harnessController(): HarnessSelectionController {
  return {
    read: () => ({
      harness: harnessType as ReturnType<HarnessSelectionController["read"]>["harness"],
      readiness: readiness as ReturnType<HarnessSelectionController["read"]>["readiness"],
      isHarnessMode: true,
      models,
      selectedModel,
      selectedModelKey: selectedModel ? { providerID: selectedModelProvider ?? harnessType, modelID: selectedModel } : undefined,
      configError,
      optionsStale,
      optionsLoading,
      draftDefaultState,
      draftDefaultLabels,
      draftDefaultModel: selectedModel
        ? { providerID: selectedModelProvider ?? harnessType, modelID: selectedModel }
        : undefined,
    }),
    hydrate: (scope: string, input?: { directory?: string; sessionId?: string }) => {
      hydrateCalls.push({ scope, directory: input?.directory, sessionId: input?.sessionId })
    },
    setHarness: (scope: string, type: string) => {
      setHarnessCalls.push({ scope, type })
    },
    setModel: (scope: string, model: { providerID: string; modelID: string }) => {
      setModelCalls.push({ scope, model })
      selectedModel = model.modelID
      selectedModelProvider = model.providerID
    },
    rememberDraftModel: () => false,
    resolveDraftDefault: (_scope, input) => {
      resolveDefaultCalls.push(input)
      return true
    },
    reprobe: () => undefined,
    markUnavailable: () => undefined,
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
  resolveDefaultCalls.length = 0
})

beforeEach(() => {
  readiness = "ready"
  harnessType = "claude-acp"
  models = []
  selectedModel = ""
  selectedModelProvider = undefined
  configError = undefined
  optionsStale = false
  optionsLoading = false
  piLoading = false
  piError = undefined
  piConnected = []
  piProviders = new Map()
  piRefreshCalls = 0
  piDefaults = {}
  draftDefaultState = "ready"
  draftDefaultLabels = undefined
  dialogState.connectProps = undefined
  dialogState.show.mockClear()
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

  test("a typeahead-while-closed change does NOT switch the harness", () => {
    // Regression: with the trigger focused (never opened), the Kobalte trigger's
    // typeahead mutates the value on a bare keystroke. Stray typing must not
    // silently switch the session's harness.
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const typeahead = container.querySelector("[data-testid='select-typeahead-codex-acp']") as HTMLButtonElement
    expect(typeahead).not.toBeNull()

    fireEvent.click(typeahead)
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

    expect(setModelCalls).toEqual([{ scope: "test-scope", model: { providerID: "claude-acp", modelID: "claude-opus-4-6" } }])
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

describe("AgentHarnessSelector — readiness UI", () => {
  test("readiness 'polling' shows the Connecting pill and not the Unavailable error", () => {
    readiness = "polling"
    const { getByText, queryByText } = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(getByText("Connecting")).toBeTruthy()
    expect(queryByText("Unavailable")).toBeNull()
  })

  test("readiness 'error' does not show the Connecting pill", () => {
    readiness = "error"
    const { queryByText } = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(queryByText("Connecting")).toBeNull()
  })

  // Cross-WP pin (fixme ledger core-harness-ownership-local:515), now LIVE after
  // WP-B9. Before B9 the harness store's readiness was an error/ready binary, so a
  // still-connecting harness never produced "polling" — the Connecting pill was
  // unreachable and a starting harness showed a red "Unavailable". Drive the real
  // store projector (harnessStatusPatch) with a startup status frame (ready:false,
  // no hard failure, not a settled switch response) and assert it yields "polling"
  // that this selector renders as "Connecting" — proving the path is reachable
  // end-to-end, not just that the selector renders a hardcoded readiness.
  test("startup status frame drives the store to 'polling', making the Connecting pill reachable [WP-B9]", () => {
    const patch = harnessStatusPatch({
      data: { type: "codex-app-server", status: "configured", ready: false },
    })
    expect(patch.readiness).toBe("polling")
    readiness = patch.readiness!
    const { getByText, queryByText } = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(getByText("Connecting")).toBeTruthy()
    expect(queryByText("Unavailable")).toBeNull()
  })
})

describe("AgentHarnessSelector — selectable Pi models", () => {
  test("resolves an unresolved Pi workspace default from connected provider models", async () => {
    harnessType = "pi"
    draftDefaultState = undefined
    piConnected = ["openai-codex"]
    piDefaults = { "openai-codex": "gpt-5.5" }
    piProviders.set("openai-codex", {
      id: "openai-codex",
      name: "OpenAI Codex",
      models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" } },
    })

    render(() => <TestAgentHarnessSelector directory="/repo" sessionId="new" />)

    await waitFor(() => expect(resolveDefaultCalls).toContainEqual({
      supportedHarnesses: expect.arrayContaining(["opencode", "pi"]),
      eligibleModels: [{ providerID: "openai-codex", modelID: "gpt-5.5" }],
      openCodeModel: undefined,
      connectedProviderIDs: ["openai-codex"],
      providerDefaults: { "openai-codex": "gpt-5.5" },
    }))
  })

  test("keeps an unresolved Pi default pending while the provider catalog has failed", async () => {
    harnessType = "pi"
    draftDefaultState = undefined
    piError = "catalog unavailable"

    render(() => <TestAgentHarnessSelector directory="/repo" sessionId="new" />)
    await Promise.resolve()

    expect(resolveDefaultCalls).toEqual([])
  })

  test("keeps the friendly saved model label visible when the exact model disappeared", () => {
    harnessType = "pi"
    selectedModel = "removed-model"
    selectedModelProvider = "openai-codex"
    draftDefaultState = "saved-model-unavailable"
    draftDefaultLabels = { provider: "OpenAI Codex", model: "GPT-5.4 Codex" }
    configError = "Saved model unavailable"
    piConnected = ["anthropic"]
    piProviders.set("anthropic", {
      id: "anthropic",
      name: "Anthropic",
      models: { sonnet: { id: "sonnet", name: "Sonnet" } },
    })

    const { container } = render(() => <TestAgentHarnessSelector />)

    expect(container.querySelector("[data-testid='model-trigger-content']")?.textContent).toContain("GPT-5.4 Codex")
    expect(container.querySelector("[aria-label*='GPT-5.4 Codex is unavailable']")).not.toBeNull()
  })

  test("switching to Pi reuses the current OpenCode model when the exact pair is connected", async () => {
    piConnected = ["anthropic"]
    piProviders.set("anthropic", {
      id: "anthropic",
      name: "Anthropic",
      models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Sonnet 4.5" } },
    })
    const { container } = render(() => (
      <TestAgentHarnessSelector
        sessionLocked={false}
        openCodeModel={() => ({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })}
      />
    ))

    fireEvent.click(container.querySelector("[data-testid='select-option-pi']") as HTMLButtonElement)

    await waitFor(() => expect(setModelCalls).toEqual([{
      scope: "test-scope",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    }]))
  })

  test("switching to Pi selects the sole configured provider default", async () => {
    piConnected = ["openai-codex"]
    piDefaults = { "openai-codex": "gpt-5.5" }
    piProviders.set("openai-codex", {
      id: "openai-codex",
      name: "OpenAI Codex",
      models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" } },
    })
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    fireEvent.click(container.querySelector("[data-testid='select-option-pi']") as HTMLButtonElement)

    await waitFor(() => expect(setModelCalls).toEqual([{
      scope: "test-scope",
      model: { providerID: "openai-codex", modelID: "gpt-5.5" },
    }]))
  })

  test("Pi renders models from the Pi-scoped provider catalog", () => {
    harnessType = "pi"
    piConnected = ["anthropic"]
    piProviders.set("anthropic", {
      id: "anthropic",
      name: "Anthropic",
      models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Sonnet 4.5" } },
    })

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.textContent).toContain("Select model")
    expect(container.querySelector("[data-testid='model-option-claude-sonnet-4-5']")).not.toBeNull()
  })

  test("selecting a connected Pi model preserves its backend provider ID", () => {
    harnessType = "pi"
    piConnected = ["anthropic"]
    piProviders.set("anthropic", {
      id: "anthropic",
      name: "Anthropic",
      models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Sonnet 4.5" } },
    })

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    fireEvent.click(container.querySelector("[data-testid='model-option-claude-sonnet-4-5']") as HTMLButtonElement)

    expect(setModelCalls).toEqual([{
      scope: "test-scope",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    }])
  })

  test("a disconnected Pi model is selected after its connection completes", async () => {
    harnessType = "pi"
    piProviders.set("anthropic", {
      id: "anthropic",
      name: "Anthropic",
      models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Sonnet 4.5" } },
    })
    const { container } = render(() => <TestAgentHarnessSelector directory="/repo" sessionId="new" />)

    fireEvent.click(container.querySelector("[data-testid='model-option-claude-sonnet-4-5']") as HTMLButtonElement)
    await waitFor(() => expect(dialogState.connectProps?.provider).toBe("anthropic"))
    piConnected = ["anthropic"]
    await dialogState.connectProps.onConnected()

    expect(setModelCalls).toContainEqual({
      scope: "test-scope",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    })
  })

  test("connection completion does not select a model removed during authentication", async () => {
    harnessType = "pi"
    piProviders.set("anthropic", {
      id: "anthropic",
      name: "Anthropic",
      models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Sonnet 4.5" } },
    })
    const { container } = render(() => <TestAgentHarnessSelector directory="/repo" sessionId="new" />)

    fireEvent.click(container.querySelector("[data-testid='model-option-claude-sonnet-4-5']") as HTMLButtonElement)
    await waitFor(() => expect(dialogState.connectProps?.provider).toBe("anthropic"))
    piConnected = ["anthropic"]
    piProviders.get("anthropic")!.models = {}
    await dialogState.connectProps.onConnected()

    expect(setModelCalls).toEqual([])
  })

  test("Pi shows an explicit empty catalog state", () => {
    harnessType = "pi"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.textContent).toContain("No Pi models available")
    expect(container.querySelector("[data-testid='model-selector']")?.getAttribute("data-disabled")).toBe("true")
  })

  test("Pi model selection is read-only after the first prompt", () => {
    harnessType = "pi"
    selectedModel = "gpt-5.2"
    selectedModelProvider = "openai-codex"
    piConnected = ["openai-codex"]
    piProviders.set("openai-codex", {
      id: "openai-codex",
      name: "OpenAI Codex",
      models: { "gpt-5.2": { id: "gpt-5.2", name: "GPT-5.2" } },
    })

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked modelLocked />)

    expect(container.querySelector("[data-testid='model-selector']")?.getAttribute("data-disabled")).toBe("true")
    expect(container.textContent).toContain("GPT-5.2")
    expect(container.querySelector("[aria-label='Start a new Pi session to choose a different model']")).not.toBeNull()
  })

  test("an existing non-Pi session keeps its model picker enabled", () => {
    harnessType = "claude-acp"
    models = [{ id: "sonnet", name: "Sonnet" }]

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked modelLocked />)

    expect(container.querySelector("[data-testid='model-selector']")?.getAttribute("data-disabled")).toBe("false")
  })

  test("Pi catalog loading and retryable failure are explicit", () => {
    harnessType = "pi"
    piLoading = true
    const loading = render(() => <TestAgentHarnessSelector />)
    expect(loading.container.textContent).toContain("Loading models")
    loading.unmount()

    piLoading = false
    piError = "catalog unavailable"
    const failed = render(() => <TestAgentHarnessSelector />)
    expect(failed.container.textContent).toContain("Unavailable")
    fireEvent.click(failed.getByRole("button", { name: "Retry loading Pi models" }))
    expect(piRefreshCalls).toBe(1)
  })

  test("claude-acp with no models still shows the Select model placeholder (unchanged)", () => {
    harnessType = "claude-acp"
    models = []

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.textContent).toContain("Select model")
  })
})
