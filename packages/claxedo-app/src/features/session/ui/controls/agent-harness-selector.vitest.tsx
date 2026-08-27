import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import type { SessionRef } from "@/platform/identity/session-ref"

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
const hydrateCalls: Array<{ scope: string; directory?: string; sessionId?: string; sessionRef?: SessionRef }> = []
const resolveDefaultCalls: unknown[] = []
const captured: Array<{ event: string; properties: Record<string, unknown> }> = []

vi.mock("@/platform/telemetry/analytics", () => ({
  capture: (event: string, properties: Record<string, unknown>) => {
    captured.push({ event, properties })
  },
  identityProps: () => ({ org_id: "org_1", user_id: "user_1", deployment_mode: "self-host" }),
}))
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
let harnessMode = true
let acpConnections: Array<{ key: `acp:${string}`; id: string; label: string; enabled: boolean }> = []
let acpRefreshCalls = 0

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

// Stub the merged harness→model picker, preserving the DOM contract these
// tests were written against: a harness trigger, one button per harness option,
// and the model control with its trigger props spread onto a real node. The
// component under test no longer imports `Select` or `ModelSelectorPopover` —
// it composes one picker — so this is where the seam moved.
vi.mock("@/features/session/composer/ui/harness-model-picker", () => ({
  HarnessModelPicker: (props: any) => {
    const options: string[] = [...props.harnessOptions]
    const groups = options.reduce((result, opt) => {
      const group = harnessGroupForTest(opt)
      result.set(group, [...(result.get(group) ?? []), opt])
      return result
    }, new Map<string, string[]>())
    return (
      <div data-testid="select" data-disabled={props.harnessDisabled?.() ? "true" : "false"}>
        <button data-testid="select-trigger" disabled={props.harnessDisabled?.()}>
          {props.harnessLabel?.(props.harness?.())}
        </button>
        {[...groups.entries()].map(([group, opts]) => (
          <div data-testid={`select-group-${group}`}>
            <span>{group}</span>
            {opts.map((opt: string) => (
              <button data-testid={`select-option-${opt}`} onClick={() => props.onHarnessSelect?.(opt)}>
                {props.harnessLabel?.(opt) ?? opt}
              </button>
            ))}
          </div>
        ))}
        <div data-testid="model-selector" data-disabled={props.modelDisabled?.() ? "true" : "false"}>
          <div
            data-testid="model-trigger-content"
            data-action="prompt-harness-model"
            title={props.triggerHint?.()}
            aria-label={props.triggerLabel}
          >
            {props.modelLabel?.()}
          </div>
          {(props.model?.().list?.() ?? []).map((item: any) => (
            <button
              data-testid={`model-option-${item.id}`}
              onClick={() => props.model?.().set?.({ modelID: item.id, providerID: item.provider?.id })}
            >
              {item.name}
            </button>
          ))}
        </div>
      </div>
    )
  },
}))

// Mirrors harnessOptionGroup in the component; the stub groups rows the same
// way so the "groups harness choices by ACP / native SDK / direct" test still
// describes what a user sees.
function harnessGroupForTest(input: string) {
  if (input.startsWith("acp:")) return "ACP"
  if (input === "claude-sdk" || input === "codex-app-server" || input === "cursor-sdk") return "Native SDK"
  return "Direct"
}

vi.mock("@opencode-ai/ui/v2/tooltip-v2", () => ({
  TooltipV2: (props: any) => (
    <span data-testid="tooltip-v2" data-value={props.value}>
      {props.children}
    </span>
  ),
}))

import { AgentHarnessSelector } from "./agent-harness-selector"
import {
  ComposerNoticeProvider,
  ComposerNoticeRow,
  createComposerNoticeChannel,
} from "@/features/session/composer/ui/composer-notice"
import { harnessStatusPatch } from "@/features/session/harness/store-state"
import type { HarnessSelectionController } from "@/features/session/harness/controller"

function harnessController(): HarnessSelectionController {
  return {
    read: () => ({
      harness: harnessType as ReturnType<HarnessSelectionController["read"]>["harness"],
      readiness: readiness as ReturnType<HarnessSelectionController["read"]>["readiness"],
      isHarnessMode: harnessMode,
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
    hydrate: (scope: string, input?: { directory?: string; sessionId?: string; sessionRef?: SessionRef }) => {
      hydrateCalls.push({ scope, directory: input?.directory, sessionId: input?.sessionId, sessionRef: input?.sessionRef })
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
    enabledAcpConnections: () => acpConnections.filter((row) => row.enabled),
    acpConnectionLabel: (key: string) => acpConnections.find((row) => row.key === key)?.label,
    refreshAcpConnections: () => {
      acpRefreshCalls += 1
      return Promise.resolve()
    },
  }
}

// Mirrors the real mount: the selector publishes into a channel owned by an
// ancestor (the new-session screen, or the composer frame) and the row renders
// there — never beside the controls.
function TestAgentHarnessSelector(props: Omit<Parameters<typeof AgentHarnessSelector>[0], "harnessController">) {
  const channel = createComposerNoticeChannel()
  return (
    <ComposerNoticeProvider channel={channel}>
      <ComposerNoticeRow notice={channel.current()} />
      <AgentHarnessSelector harnessController={harnessController()} {...props} />
    </ComposerNoticeProvider>
  )
}

function noticeRow(container: HTMLElement) {
  return container.querySelector("[data-component='composer-notice']")
}

afterEach(() => {
  cleanup()
  setHarnessCalls.length = 0
  setModelCalls.length = 0
  hydrateCalls.length = 0
  resolveDefaultCalls.length = 0
  captured.length = 0
})

beforeEach(() => {
  harnessMode = true
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
  acpConnections = []
  acpRefreshCalls = 0
  dialogState.connectProps = undefined
  dialogState.show.mockClear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentHarnessSelector — existing session handoff", () => {
  test("keeps both the harness and OpenCode model choices enabled", () => {
    harnessMode = false
    const model = {
      list: () => [{ id: "model-1", name: "Model 1", provider: { id: "provider-1", name: "Provider 1" } }],
      current: () => undefined,
      visible: () => true,
      set: () => undefined,
    }
    const { container } = render(() => (
      <TestAgentHarnessSelector
        sessionLocked
        openCode={{
          model: () => model,
          label: () => "Model 1",
          loading: () => false,
          showVariantSelector: () => false,
          variants: () => [],
          currentVariant: () => undefined,
          variantLabel: (value) => value,
          onVariantSelect: () => undefined,
        }}
      />
    ))

    expect(container.querySelector("[data-testid='select']")?.getAttribute("data-disabled")).toBe("false")
    expect(container.querySelector("[data-testid='model-selector']")?.getAttribute("data-disabled")).toBe("false")
  })

  test("trigger is enabled when sessionLocked is false (new session)", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(false)
  })

  test("trigger stays enabled for an existing session", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(false)
  })

  test("trigger is disabled while polling", () => {
    readiness = "polling"
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(true)
  })

  test("select data-disabled reflects runtime readiness, not session age", () => {
    const { container: unlocked } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    expect(unlocked.querySelector("[data-testid='select']")!.getAttribute("data-disabled")).toBe("false")
    cleanup()

    const { container: locked } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)
    expect(locked.querySelector("[data-testid='select']")!.getAttribute("data-disabled")).toBe("false")
  })

  test("clicking an option calls setHarness when unlocked", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-codex-app-server']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toHaveLength(1)
    expect(setHarnessCalls[0].type).toBe("codex-app-server")
  })

  test("clicking the current harness does not call setHarness", () => {
    harnessType = "claude-sdk"
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-claude-sdk']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toHaveLength(0)
  })

  test("clicking an option captures harness_selected with an id-only property allowlist", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-codex-app-server']") as HTMLButtonElement

    fireEvent.click(option)

    const event = captured.find((entry) => entry.event === "harness_selected")
    expect(event).toBeDefined()
    expect(event?.properties.harness).toBe("codex-app-server")
    // The guard against future PII creep: this enumerates the exact allowed
    // keys. Tripwire — add a forbidden property (e.g. `title`) at the call site
    // in agent-harness-selector.tsx, watch this fail, then remove it.
    expect(Object.keys(event?.properties ?? {}).sort()).toEqual(
      ["deployment_mode", "harness", "org_id", "surface", "user_id"].sort(),
    )
  })

  test("does not capture harness_selected when the click is a no-op (the current harness)", () => {
    harnessType = "claude-sdk"
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    // claude-sdk is already current — re-picking it must not emit telemetry.
    fireEvent.click(container.querySelector("[data-testid='select-option-claude-sdk']") as HTMLButtonElement)

    expect(captured.filter((entry) => entry.event === "harness_selected")).toEqual([])
  })

  // RETIRED: "a typeahead-while-closed change does NOT switch the harness".
  //
  // That guarded a hazard of the Kobalte `Select` this control used to be: with
  // the trigger focused but never opened, its typeahead mutated the value on a
  // bare keystroke, and `openedViaMenu` existed solely to reject the resulting
  // onChange. The merged picker is a Popover whose harness rows are plain
  // buttons, so there is no value-mutating path that is not a click — the test
  // could only ever assert against its own stub. What still holds is covered by
  // the no-op and locked cases around it.

  test("clicking an option hands off an existing session", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)
    const option = container.querySelector("[data-testid='select-option-codex-app-server']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toEqual([{ scope: "test-scope", type: "codex-app-server" }])
  })

  test("existing sessions can hand off to built-in and operator ACP harnesses", () => {
    acpConnections = [{ key: "acp:gemini", id: "gemini", label: "Gemini", enabled: true }]
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)

    for (const runner of ["claude-sdk", "codex-app-server", "cursor-sdk", "pi", "opencode", "acp:gemini"]) {
      const opt = container.querySelector(`[data-testid='select-option-${runner}']`) as HTMLButtonElement
      fireEvent.click(opt)
    }
    expect(setHarnessCalls).toHaveLength(1)
  })

  test("only starts one runner switch while a switch is in flight", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    for (const runner of ["claude-sdk", "codex-app-server", "cursor-sdk", "pi", "opencode"]) {
      const opt = container.querySelector(`[data-testid='select-option-${runner}']`) as HTMLButtonElement
      fireEvent.click(opt)
    }
    expect(setHarnessCalls).toEqual([{ scope: "test-scope", type: "claude-sdk" }])
  })

  test("groups harness choices: static Native SDK and Direct, discovery-driven ACP", () => {
    acpConnections = [
      { key: "acp:gemini", id: "gemini", label: "Gemini", enabled: true },
      { key: "acp:hermes", id: "hermes", label: "Hermes", enabled: false },
    ]
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(container.querySelector("[data-testid='select-group-Native SDK']")?.textContent).toContain("Claude")
    expect(container.querySelector("[data-testid='select-group-Native SDK']")?.textContent).toContain("Codex")
    expect(container.querySelector("[data-testid='select-group-Native SDK']")?.textContent).toContain("Cursor")
    expect(container.querySelector("[data-testid='select-group-Direct']")?.textContent).toContain("Pi")
    expect(container.querySelector("[data-testid='select-group-Direct']")?.textContent).toContain("OpenCode")
    // The ACP group is exactly the ENABLED operator connections, with the
    // server-provided labels; disabled rows are absent.
    expect(container.querySelector("[data-testid='select-group-ACP']")?.textContent).toContain("Gemini")
    expect(container.querySelector("[data-testid='select-group-ACP']")?.textContent).not.toContain("Hermes")
    // The first-party ACP trio is no longer a built-in picker choice.
    expect(container.querySelector("[data-testid='select-option-claude-acp']")).toBeNull()
    expect(container.querySelector("[data-testid='select-option-codex-acp']")).toBeNull()
    expect(container.querySelector("[data-testid='select-option-cursor-acp']")).toBeNull()
  })

  test("with no enabled operator connections the ACP group is absent", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    expect(container.querySelector("[data-testid='select-group-ACP']")).toBeNull()
  })

  test("selecting an operator connection sends only its canonical key", () => {
    acpConnections = [{ key: "acp:gemini", id: "gemini", label: "Gemini", enabled: true }]
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    fireEvent.click(container.querySelector("[data-testid='select-option-acp:gemini']") as HTMLButtonElement)
    expect(setHarnessCalls).toEqual([{ scope: "test-scope", type: "acp:gemini" }])
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

  test("surfaces runner config errors in the notice row, in words, with no hover needed", () => {
    configError = "Authentication required. Please run 'agent login' first."
    optionsStale = true
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const row = noticeRow(container)

    expect(row).not.toBeNull()
    expect(row!.getAttribute("data-notice")).toBe("models-failed")
    expect(row!.getAttribute("data-tone")).toBe("critical")
    expect(row!.textContent).toContain("Couldn't load Claude models")
    expect(row!.textContent).toContain("Authentication required. Please run 'agent login' first.")
    // The reason is readable without hovering anything — the old unlabeled dot
    // was the only place it existed.
    expect(container.querySelector("[data-testid='tooltip-v2']")).toBeNull()
  })

  test("surfaces Cursor SDK auth requirements in the notice row", () => {
    harnessType = "cursor-sdk"
    configError = "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login."
    optionsStale = true
    models = []

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const row = noticeRow(container)

    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("Couldn't load Cursor models")
    expect(row!.textContent).toContain(
      "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login.",
    )
  })

  test("a failed model list disables the control without restating the error on it", () => {
    configError = "ACP connection closed"
    optionsStale = true
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    // The control names the model it still holds; the row alone reports the fault.
    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.textContent).toContain("Default (recommended)")
    expect(trigger?.textContent).not.toContain("Unavailable")
  })

  test("a dead runtime outranks the option-discovery failure it caused", () => {
    readiness = "error"
    configError = "Failed to load model options"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    const row = noticeRow(container)
    expect(row!.getAttribute("data-notice")).toBe("runtime-unavailable")
    expect(row!.textContent).toContain("Claude runtime is unavailable")
    // The harness e2e specs locate this state by title.
    expect(row!.getAttribute("title")).toBe("Agent runtime unreachable after timeout")
    // Exactly one surface reports it, where four used to.
    expect(container.querySelectorAll("[data-component='composer-notice']")).toHaveLength(1)
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
    expect(noticeRow(container)!.textContent).toContain("Claude runtime is unavailable")
  })

  test("a healthy harness publishes no notice at all", () => {
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(noticeRow(container)).toBeNull()
  })

  test("a merely-stale list stays a hint on the control and never becomes a row", () => {
    optionsStale = true
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(noticeRow(container)).toBeNull()
    const trigger = container.querySelector("[data-action='prompt-harness-model']")
    expect(trigger?.getAttribute("title")).toBe("Model list may be outdated")
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
      expect(hydrateCalls).toEqual([{ scope: "test-scope", directory: "/repo/main", sessionId: "ses_1", sessionRef: undefined }])
    })
  })

  test("rehydrates when an authoritative session ref upgrades in place", async () => {
    const [sessionRef, setSessionRef] = createSignal<SessionRef>({
      host: "central",
      sessionId: "ses_1",
    })
    render(() => (
      <TestAgentHarnessSelector
        active
        directory="/repo/main"
        sessionId="ses_1"
        sessionRef={sessionRef()}
        surfaceId="surface_1"
        sessionLocked
      />
    ))

    await waitFor(() => expect(hydrateCalls).toHaveLength(1))
    setSessionRef({ host: "central", sessionId: "ses_1", harness: { id: "pi" } })

    await waitFor(() => {
      expect(hydrateCalls).toHaveLength(2)
      expect(hydrateCalls[1]?.sessionRef?.harness?.id).toBe("pi")
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
    const { getAllByText, getByTestId, queryByText } = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(getAllByText("Connecting")).toHaveLength(2)
    expect(getByTestId("model-trigger-content").textContent).toBe("Connecting")
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
    const { getAllByText, queryByText } = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(getAllByText("Connecting")).toHaveLength(2)
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
    const row = noticeRow(container)
    expect(row!.getAttribute("data-notice")).toBe("saved-model-unavailable")
    expect(row!.getAttribute("data-tone")).toBe("warning")
    expect(row!.textContent).toContain("GPT-5.4 Codex is unavailable")
    expect(row!.textContent).toContain("Reconnect its provider, or choose another model.")
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
    // A locked-by-design control explains itself on the control — it is not a
    // fault, so it must never reach the notice row.
    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.getAttribute("title")).toBe("Start a new Pi session to choose a different model")
    expect(trigger?.getAttribute("aria-label")).toContain("Start a new Pi session to choose a different model")
    expect(noticeRow(container)).toBeNull()
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
    const row = noticeRow(failed.container)
    expect(row!.textContent).toContain("Couldn't load Pi models")
    expect(row!.textContent).toContain("catalog unavailable")
    // Retry lives inside the row it explains, not as a loose button beside it.
    fireEvent.click(failed.getByRole("button", { name: "Retry loading Pi models" }))
    expect(row!.contains(failed.getByRole("button", { name: "Retry loading Pi models" }))).toBe(true)
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
