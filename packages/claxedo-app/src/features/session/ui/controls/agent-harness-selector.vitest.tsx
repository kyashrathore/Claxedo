import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library"
import { createSignal, For } from "solid-js"
import type { HarnessSelection, SessionRef } from "@/platform/identity/session-ref"
import type { HarnessConnectionState } from "../../harness/profile"

type CatalogProvider = {
  id: string
  name: string
  models: Record<string, { id: string; name: string }>
}

const dialogState = vi.hoisted(() => ({
  show: vi.fn(),
}))
const discovery = vi.hoisted(() => vi.fn())
vi.mock("@/platform/api/api", async (original) => ({
  ...await original<typeof import("@/platform/api/api")>(),
  authFetch: discovery,
  getClaxedoServerUrl: () => "http://localhost",
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const setHarnessCalls: Array<{ scope: string; type: HarnessSelection }> = []
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
let connectionState: HarnessConnectionState | undefined
let harnessType: HarnessSelection = { kind: "native", harnessId: "claude" }
let models: Array<{ id: string; name: string; connected?: boolean }> = []
let selectedModel = ""
let selectedModelProvider: string | undefined
let configError: string | undefined
let optionsStale = false
let optionsLoading = false
let catalogLoading = false
let catalogError: string | undefined
let catalogConnected: string[] = []
let catalogProviders = new Map<string, CatalogProvider>()
let catalogRefreshCalls = 0
let catalogDefaults: Record<string, string> = {}
let draftDefaultState: "ready" | "choose-model" | "saved-model-unavailable" | "unsupported-placement" | undefined = "ready"
let draftDefaultLabels: { provider?: string; model?: string } | undefined
let harnessMode = true

vi.mock("@/features/session/app-ports", () => ({
  useProviders: () => ({
    resolved: () => true,
    all: () => catalogProviders,
    connected: () => catalogConnected.flatMap((id) => {
      const provider = catalogProviders.get(id)
      return provider ? [provider] : []
    }),
    loading: () => catalogLoading,
    error: () => catalogError,
    refresh: async () => { catalogRefreshCalls += 1 },
    default: () => catalogDefaults,
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
  // store-state → store-policy re-exports this at module load; the live
  // harnessStatusPatch assertion below doesn't exercise it, so a stub suffices.
  isDraftPaneScope: (scope: string) => scope.startsWith("draft:"),
}))

// Stub the merged harness→model picker, preserving the DOM contract these
// tests were written against: a harness trigger, one button per harness option,
// and the model control with its trigger props spread onto a real node. The
// component under test composes one picker rather than importing `Select` or
// `ModelSelectorPopover`, so this is the seam.
vi.mock("@/features/session/composer/ui/harness-model-picker", () => ({
  HarnessModelPicker: (props: any) => {
    return (
      <div data-testid="select" data-disabled={props.harnessDisabled?.() ? "true" : "false"}>
        <button data-testid="select-trigger" disabled={props.harnessDisabled?.()}>
          {props.harnessLabel?.(props.harness?.())}
        </button>
        <For each={props.harnessOptions}>{(opt: HarnessSelection) => (
          <button
            data-testid={`select-option-${harnessId(opt)}`}
            data-group={props.harnessGroup(opt)}
            onClick={() => props.onHarnessSelect?.(opt)}
          >
            {props.harnessLabel?.(opt) ?? harnessId(opt)}
          </button>
        )}</For>
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
              data-connected={item.connected === undefined ? undefined : String(item.connected)}
              data-provider-name={item.provider?.name}
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

function harnessId(input: HarnessSelection) {
  return input.kind === "native" ? input.harnessId : input.connectionId
}

vi.mock("@opencode-ai/ui/v2/tooltip-v2", () => ({
  TooltipV2: (props: any) => (
    <span data-testid="tooltip-v2" data-value={props.value}>
      {props.children}
    </span>
  ),
}))

const navigated = vi.fn()
// Connecting a provider is a navigation now, not a dialog; these suites mount
// the control without a router.
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigated, useLocation: () => ({ pathname: "/", search: "" }) }))

import { AgentHarnessSelector } from "./agent-harness-selector"
import {
  ComposerNoticeProvider,
  ComposerNoticeRow,
  createComposerNoticeChannel,
} from "@/features/session/composer/ui/composer-notice"
import { harnessStatusPatch } from "@/features/session/harness/store-state"
import type { HarnessSelectionController } from "@/features/session/harness/controller"

function harnessController(): HarnessSelectionController {
  const [revision, refresh] = createSignal(0)
  return {
    read: () => {
      revision()
      return {
      harness: harnessType,
      readiness: readiness as ReturnType<HarnessSelectionController["read"]>["readiness"],
      isHarnessMode: harnessMode,
      connectionState,
      models,
      selectedModel,
      selectedModelKey: selectedModel ? { providerID: selectedModelProvider ?? harnessId(harnessType), modelID: selectedModel } : undefined,
      configError,
      optionsStale,
      optionsLoading,
      draftDefaultState,
      draftDefaultLabels,
      draftDefaultModel: selectedModel
        ? { providerID: selectedModelProvider ?? harnessId(harnessType), modelID: selectedModel }
        : undefined,
      }
    },
    hydrate: (scope: string, input?: { directory?: string; sessionId?: string; sessionRef?: SessionRef }) => {
      hydrateCalls.push({ scope, directory: input?.directory, sessionId: input?.sessionId, sessionRef: input?.sessionRef })
    },
    setHarness: (scope: string, type: HarnessSelection) => {
      setHarnessCalls.push({ scope, type })
    },
    setModel: (scope: string, model: { providerID: string; modelID: string }) => {
      setModelCalls.push({ scope, model })
      selectedModel = model.modelID
      selectedModelProvider = model.providerID
      refresh((value) => value + 1)
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

// Mirrors the real mount: the selector publishes into a channel owned by an
// ancestor (the new-session screen, or the composer frame) and the row renders
// there — never beside the controls.
function TestAgentHarnessSelector(props: Omit<Parameters<typeof AgentHarnessSelector>[0], "harnessController">) {
  const channel = createComposerNoticeChannel()
  const controller = harnessController()
  return (
    <ComposerNoticeProvider channel={channel}>
      <ComposerNoticeRow notice={channel.current()} />
      <AgentHarnessSelector harnessController={controller} {...props} />
    </ComposerNoticeProvider>
  )
}

function noticeRow(container: HTMLElement) {
  return container.querySelector("[data-component='composer-notice']")
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setHarnessCalls.length = 0
  setModelCalls.length = 0
  hydrateCalls.length = 0
  resolveDefaultCalls.length = 0
  captured.length = 0
})

beforeEach(() => {
  connectionState = undefined
  discovery.mockReset().mockImplementation(async () => Response.json({ status: "supported", connections: [] }))
  harnessMode = true
  readiness = "ready"
  harnessType = { kind: "native", harnessId: "claude" }
  models = []
  selectedModel = ""
  selectedModelProvider = undefined
  configError = undefined
  optionsStale = false
  optionsLoading = false
  catalogLoading = false
  catalogError = undefined
  catalogConnected = []
  catalogProviders = new Map()
  catalogRefreshCalls = 0
  catalogDefaults = {}
  draftDefaultState = "ready"
  draftDefaultLabels = undefined
  dialogState.show.mockClear()
  navigated.mockClear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentHarnessSelector — existing session handoff", () => {
  test("shows observed handshake state separately from model discovery readiness", () => {
    harnessType = { kind: "connection", connectionId: "acp" }
    for (const [state, label] of [["configured", "Configured"], ["connecting", "Connecting"], ["ready", "Connected"]] as const) {
      connectionState = { connectionId: "acp", state }
      const view = render(() => <TestAgentHarnessSelector />)
      const badge = view.container.querySelector(`[data-connection-state='${state}']`)
      expect(badge?.textContent).toBe(label)
      if (state === "ready") expect(badge?.getAttribute("title")).toContain("Authentication is checked")
      view.unmount()
    }
  })
  test("unsupported discovery does not create a connection group or schedule retries", async () => {
    discovery.mockImplementation(async () => Response.json({ status: "unsupported", reason: "operator_local_configuration" }))
    vi.useFakeTimers()
    const { container } = render(() => <TestAgentHarnessSelector />)
    await discovery.mock.results[0].value
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(container.querySelector("[data-group='Connections']")).toBeNull()
    expect(discovery).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(discovery).toHaveBeenCalledTimes(1)
  })

  test("keeps native Pi and a connection named pi as separate choices", async () => {
    discovery.mockImplementation(async () => Response.json({ status: "supported", connections: [{
      connectionId: "pi", label: "Remote Pi", enabled: true, readiness: "ready",
      capabilities: { abort: true, reconnect: false, replay: true, permissions: true, questions: false, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false },
    }] }))
    const view = render(() => <TestAgentHarnessSelector />)
    await waitFor(() => expect(view.getByText("Remote Pi")).toBeTruthy())
    expect(view.container.querySelectorAll("[data-testid='select-option-pi']")).toHaveLength(2)
    fireEvent.click(view.getByText("Remote Pi"))
    await waitFor(() => expect(setHarnessCalls.at(-1)?.type).toEqual({ kind: "connection", connectionId: "pi" }))
  })
  test("keeps harness selection enabled while disabling an unavailable model list", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked />)

    expect(container.querySelector("[data-testid='select']")?.getAttribute("data-disabled")).toBe("false")
    expect(container.querySelector("[data-testid='model-selector']")?.getAttribute("data-disabled")).toBe("true")
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
    const option = container.querySelector("[data-testid='select-option-codex']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toHaveLength(1)
    expect(setHarnessCalls[0].type).toEqual({ kind: "native", harnessId: "codex" })
  })

  test("clicking the current harness does not call setHarness", () => {
    harnessType = { kind: "native", harnessId: "claude" }
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-claude']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toHaveLength(0)
  })

  test("clicking an option captures harness_selected with an id-only property allowlist", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-codex']") as HTMLButtonElement

    fireEvent.click(option)

    const event = captured.find((entry) => entry.event === "harness_selected")
    expect(event).toBeDefined()
    expect(event?.properties.harness).toBe("codex")
    expect(event?.properties.targetKind).toBe("native")
    // The guard against future PII creep: this enumerates the exact allowed
    // keys. Tripwire — add a forbidden property (e.g. `title`) at the call site
    // in agent-harness-selector.tsx, watch this fail, then remove it.
    expect(Object.keys(event?.properties ?? {}).sort()).toEqual(
      ["deployment_mode", "harness", "org_id", "surface", "targetKind", "user_id"].sort(),
    )
  })

  test("does not capture harness_selected when the click is a no-op (the current harness)", () => {
    harnessType = { kind: "native", harnessId: "claude" }
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    fireEvent.click(container.querySelector("[data-testid='select-option-claude']") as HTMLButtonElement)

    expect(captured.filter((entry) => entry.event === "harness_selected")).toEqual([])
  })

  test("clicking an option hands off an existing session", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={true} />)
    const option = container.querySelector("[data-testid='select-option-codex']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setHarnessCalls).toEqual([{ scope: "test-scope", type: { kind: "native", harnessId: "codex" } }])
  })

  test.each([false, true])("only starts one in-flight runner switch with sessionLocked=%s", (sessionLocked) => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={sessionLocked} />)

    for (const runner of ["claude", "codex", "cursor", "pi"]) {
      const opt = container.querySelector(`[data-testid='select-option-${runner}']`) as HTMLButtonElement
      fireEvent.click(opt)
    }
    expect(setHarnessCalls).toEqual([{ scope: "test-scope", type: { kind: "native", harnessId: "codex" } }])
  })

  test("forwards supported native options and their authoritative group labels", () => {
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const options = [...container.querySelectorAll('[data-testid^="select-option-"]')]
    expect(options.map((option) => ({ label: option.textContent, group: option.getAttribute("data-group") }))).toEqual([
      { label: "Claude Code", group: "Native SDK" },
      { label: "Codex", group: "Native SDK" },
      { label: "Cursor", group: "Native SDK" },
      { label: "Pi", group: "Native SDK" },
      { label: "OpenCode", group: "Native SDK" },
    ])
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

    expect(container.querySelector("[data-testid='model-trigger-content']")?.textContent).toBe("Sonnet 4.6")
    fireEvent.click(container.querySelector("[data-testid='model-option-claude-opus-4-6']") as HTMLButtonElement)

    expect(setModelCalls).toEqual([{ scope: "test-scope", model: { providerID: "claude", modelID: "claude-opus-4-6" } }])
    expect(container.querySelector("[data-testid='model-trigger-content']")?.textContent).toBe("Opus 4.6")
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
    harnessType = { kind: "native", harnessId: "claude" }
    configError = "Authentication required. Please run 'agent login' first."
    models = []
    selectedModel = ""

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const row = noticeRow(container)

    expect(row).not.toBeNull()
    expect(row!.getAttribute("data-notice")).toBe("models-failed")
    expect(row!.getAttribute("data-tone")).toBe("critical")
    expect(row!.textContent).toContain("Couldn't load Claude Code models")
    expect(row!.textContent).toContain("Authentication required. Please run 'agent login' first.")
    // The reason is readable without hovering anything — the old unlabeled dot
    // was the only place it existed.
    expect(container.querySelector("[data-testid='tooltip-v2']")).toBeNull()
  })

  test("surfaces fresh option-discovery failures without waiting for stale", () => {
    harnessType = { kind: "native", harnessId: "claude" }
    configError = "No model options available"
    optionsStale = false
    models = []
    selectedModel = ""

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const row = noticeRow(container)

    expect(row).not.toBeNull()
    expect(row!.getAttribute("data-notice")).toBe("models-failed")
    expect(row!.textContent).toContain("Couldn't load Claude Code models")
    expect(row!.textContent).toContain("No model options available")
    expect(container.querySelector("[data-testid='model-trigger-content']")?.textContent).toContain("Select model")
  })

  test("surfaces Cursor SDK auth requirements in the notice row", () => {
    harnessType = { kind: "native", harnessId: "cursor" }
    configError = "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login."
    optionsStale = true
    models = []
    selectedModel = ""

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)
    const row = noticeRow(container)

    expect(row).not.toBeNull()
    expect(row!.getAttribute("data-notice")).toBe("setup-required")
    expect(row!.getAttribute("data-tone")).toBe("warning")
    expect(row!.textContent).toContain("Cursor is not set up")
    expect(row!.textContent).toContain("Add credentials in Settings → Providers.")
    expect(row!.textContent).toContain("Open Providers")
    expect(container.textContent).not.toContain("Default (recommended)")
    expect(container.querySelector("[data-testid='model-trigger-content']")?.textContent).toContain("Select model")
  })

  test("never shows the client default placeholder for Cursor while options are unresolved", () => {
    harnessType = { kind: "native", harnessId: "cursor" }
    optionsLoading = true
    selectedModel = ""
    models = []

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(container.textContent).toContain("Loading models")
    expect(container.textContent).not.toContain("Default (recommended)")
  })

  test("does not mark Cursor SDK models as configured when options failed to load", () => {
    harnessType = { kind: "native", harnessId: "cursor" }
    configError = "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login."
    models = []
    selectedModel = ""

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    expect(container.textContent).not.toContain("Configured")
    expect(noticeRow(container)?.textContent).toContain("Cursor is not set up")
  })

  test("a failed model list disables the control without restating the error on it", () => {
    configError = "ACP connection closed"
    optionsStale = true
    models = []
    selectedModel = ""

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    // The control stays neutral; the row alone reports the fault.
    const trigger = container.querySelector("[data-testid='model-trigger-content']")
    expect(trigger?.textContent).toContain("Select model")
    expect(trigger?.textContent).not.toContain("Unavailable")
  })

  test("a dead runtime outranks the option-discovery failure it caused", () => {
    harnessType = { kind: "native", harnessId: "claude" }
    readiness = "error"
    configError = "Failed to load model options"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    const row = noticeRow(container)
    expect(row!.getAttribute("data-notice")).toBe("runtime-unavailable")
    expect(row!.textContent).toContain("Claude Code runtime is unavailable")
    // The harness e2e specs locate this state by title.
    expect(row!.getAttribute("title")).toBe("Agent runtime unreachable after timeout")
    // One notice, not one per surface.
    expect(container.querySelectorAll("[data-component='composer-notice']")).toHaveLength(1)
  })

  test("keeps the selected model label when runner config fails after model resolution", () => {
    harnessType = { kind: "native", harnessId: "claude" }
    readiness = "error"
    configError = "Failed to initialize runner"
    models = [{ id: "default", name: "Default (recommended)" }]
    selectedModel = "default"

    const { container } = render(() => <TestAgentHarnessSelector sessionLocked={false} />)

    const selector = container.querySelector("[data-testid='model-selector']")
    expect(selector).not.toBeNull()
    expect(selector!.getAttribute("data-disabled")).toBe("true")
    expect(container.textContent).toContain("Default (recommended)")
    expect(noticeRow(container)!.textContent).toContain("Claude Code runtime is unavailable")
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
      host: "workspace",
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
    setSessionRef({ host: "workspace", sessionId: "ses_1", harness: { kind: "native", harnessId: "pi" } })

    await waitFor(() => {
      expect(hydrateCalls).toHaveLength(2)
      expect(hydrateCalls[1]?.sessionRef?.harness).toEqual({ kind: "native", harnessId: "pi" })
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
    const view = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(view.getAllByText("Connecting")).toHaveLength(2)
    expect(view.getByTestId("model-trigger-content").textContent).toBe("Connecting")
    expect(view.queryByText("Unavailable")).toBeNull()
  })

  test("readiness 'error' does not show the Connecting pill", () => {
    readiness = "error"
    const view = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(view.queryByText("Connecting")).toBeNull()
  })

  // Drives the real store projector with a startup status frame (ready:false, no
  // hard failure, not a settled switch response) so the "polling" readiness the
  // Connecting pill depends on is reached through harnessStatusPatch rather than
  // hardcoded.
  test("startup status frame drives the store to 'polling', making the Connecting pill reachable", () => {
    const patch = harnessStatusPatch({
      data: { type: { kind: "native", harnessId: "codex" }, status: "configured", ready: false },
    })
    expect(patch.readiness).toBe("polling")
    readiness = patch.readiness!
    const view = render(() => (
      <TestAgentHarnessSelector active directory="/repo/main" sessionId="ses_1" sessionLocked={false} />
    ))
    expect(view.getAllByText("Connecting")).toHaveLength(2)
    expect(view.queryByText("Unavailable")).toBeNull()
  })
})

describe("AgentHarnessSelector — native Pi models", () => {
  test("selects Pi's runtime model through the shared controller, including an existing session", () => {
    harnessType = { kind: "native", harnessId: "pi" }
    models = [{ id: "anthropic/sonnet", name: "Sonnet" }, { id: "openai/gpt", name: "GPT" }]
    selectedModel = "anthropic/sonnet"
    const { container } = render(() => <TestAgentHarnessSelector sessionLocked />)
    expect(container.querySelector("[data-testid='model-selector']")?.getAttribute("data-disabled")).toBe("false")
    fireEvent.click(container.querySelector("[data-testid='model-option-openai/gpt']") as HTMLButtonElement)
    expect(setModelCalls).toEqual([{ scope: "test-scope", model: { providerID: "pi", modelID: "openai/gpt" } }])
    expect(resolveDefaultCalls).toEqual([])
  })

  test("does not mark Pi catalog models as configured just because the list loaded", () => {
    harnessType = { kind: "native", harnessId: "pi" }
    models = [
      { id: "amazon-bedrock/nova", name: "Nova 2 Lite", connected: false },
      { id: "anthropic/sonnet", name: "Sonnet", connected: true },
    ]
    selectedModel = "amazon-bedrock/nova"

    const { container } = render(() => <TestAgentHarnessSelector />)

    expect(container.querySelector("[data-testid='model-option-amazon-bedrock/nova']")?.getAttribute("data-connected")).toBe("false")
    expect(container.querySelector("[data-testid='model-option-amazon-bedrock/nova']")?.getAttribute("data-provider-name")).toBe("Amazon Bedrock")
    expect(container.querySelector("[data-testid='model-option-anthropic/sonnet']")?.getAttribute("data-connected")).toBe("true")
    fireEvent.click(container.querySelector("[data-testid='model-option-amazon-bedrock/nova']") as HTMLButtonElement)
    expect(setModelCalls).toEqual([])
    expect(navigated).toHaveBeenCalledWith("/settings/models")
    expect(container.querySelector("[data-testid='model-option-anthropic/sonnet']")?.getAttribute("data-provider-name")).toBe("Anthropic")
  })

  test("keeps a missing saved model named while offering the machine's available models", () => {
    harnessType = { kind: "native", harnessId: "pi" }
    selectedModel = "openai/removed"
    selectedModelProvider = "pi"
    draftDefaultState = "saved-model-unavailable"
    draftDefaultLabels = { model: "GPT-5.4 Codex" }
    configError = "Saved model unavailable"
    models = [{ id: "anthropic/sonnet", name: "Sonnet" }]
    const { container } = render(() => <TestAgentHarnessSelector />)
    expect(container.querySelector("[data-testid='model-trigger-content']")?.textContent).toContain("GPT-5.4 Codex")
    expect(noticeRow(container)?.getAttribute("data-notice")).toBe("saved-model-unavailable")
  })

  test("shows loading, empty, and failed process discovery explicitly", () => {
    harnessType = { kind: "native", harnessId: "pi" }
    models = []
    optionsLoading = true
    const loading = render(() => <TestAgentHarnessSelector />)
    expect(loading.container.textContent).toContain("Loading models")
    loading.unmount()
    optionsLoading = false
    const empty = render(() => <TestAgentHarnessSelector />)
    expect(empty.container.querySelector("[data-testid='model-selector']")?.getAttribute("data-disabled")).toBe("true")
    empty.unmount()
    configError = "Pi process unavailable"
    const failed = render(() => <TestAgentHarnessSelector />)
    expect(noticeRow(failed.container)?.textContent).toContain("Pi process unavailable")
    expect(failed.getByRole("button", { name: "Retry loading harness models" })).toBeTruthy()
  })

})

describe("AgentHarnessSelector — native harness model visibility", () => {
  test("hides a reported model the user hid in Settings, but never the selected one", () => {
    harnessType = { kind: "native", harnessId: "claude" }
    models = [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }, { id: "legacy", name: "Legacy" }]
    selectedModel = "legacy"
    const visible = vi.fn((model: { providerID: string; modelID: string }) => model.modelID === "opus")

    const { container } = render(() => (
      <TestAgentHarnessSelector
        providerModel={() => ({
          list: () => [],
          current: () => undefined,
          visible,
          set: () => undefined,
        })}
      />
    ))

    expect(container.querySelector("[data-testid='model-option-opus']")).not.toBeNull()
    expect(container.querySelector("[data-testid='model-option-sonnet']")).toBeNull()
    expect(container.querySelector("[data-testid='model-option-legacy']")).not.toBeNull()
    expect(visible).toHaveBeenCalledWith({ providerID: "claude", modelID: "sonnet" }, {})
  })
})

describe("AgentHarnessSelector — OpenCode provider catalog", () => {
  test("applies provider visibility preferences to the authoritative OpenCode catalog", () => {
    harnessType = { kind: "native", harnessId: "opencode" }
    catalogConnected = ["pi"]
    catalogProviders.set("pi", {
      id: "pi",
      name: "OpenCode",
      models: {
        virtual: { id: "virtual", name: "Virtual" },
        legacy: { id: "legacy", name: "Legacy" },
      },
    })

    const { container } = render(() => (
      <TestAgentHarnessSelector
        providerModel={() => ({
          list: () => [],
          current: () => undefined,
          visible: ({ modelID }) => modelID !== "legacy",
          set: () => undefined,
        })}
      />
    ))

    expect(container.querySelector("[data-testid='model-option-virtual']")).not.toBeNull()
    expect(container.querySelector("[data-testid='model-option-legacy']")).toBeNull()
  })

  test("evaluates OpenCode visibility against the OpenCode-scoped provider defaults", () => {
    harnessType = { kind: "native", harnessId: "opencode" }
    catalogConnected = ["pi"]
    catalogDefaults = { pi: "virtual" }
    catalogProviders.set("pi", {
      id: "pi",
      name: "OpenCode",
      models: { virtual: { id: "virtual", name: "Virtual" } },
    })
    const visible = vi.fn((_model, defaults?: Record<string, string>) => defaults?.pi === "virtual")

    const { container } = render(() => (
      <TestAgentHarnessSelector
        providerModel={() => ({
          list: () => [],
          current: () => undefined,
          visible,
          set: () => undefined,
        })}
      />
    ))

    expect(container.querySelector("[data-testid='model-option-virtual']")).not.toBeNull()
    expect(visible).toHaveBeenCalledWith(
      { providerID: "pi", modelID: "virtual" },
      { pi: "virtual" },
    )
  })

  test("projects the selected OpenCode model into the provider catalog used by submit", async () => {
    harnessType = { kind: "native", harnessId: "opencode" }
    selectedModel = "virtual"
    selectedModelProvider = "pi"
    catalogConnected = ["pi"]
    catalogProviders.set("pi", {
      id: "pi",
      name: "OpenCode",
      models: { virtual: { id: "virtual", name: "Virtual" } },
    })
    const setProviderModel = vi.fn()

    render(() => (
      <TestAgentHarnessSelector
        providerModel={() => ({
          // A remote workspace's directory-scoped picker list can still be
          // empty; the explicit OpenCode catalog above remains authoritative.
          list: () => [],
          current: () => undefined,
          visible: () => true,
          set: setProviderModel,
        })}
      />
    ))

    await waitFor(() => expect(setProviderModel).toHaveBeenCalledWith(
      { providerID: "pi", modelID: "virtual" },
      { recent: false },
    ))
  })

  test("resolves an unresolved OpenCode workspace default from connected provider models", async () => {
    harnessType = { kind: "native", harnessId: "opencode" }
    draftDefaultState = undefined
    catalogConnected = ["openai-codex"]
    catalogDefaults = { "openai-codex": "gpt-5.5" }
    catalogProviders.set("openai-codex", {
      id: "openai-codex",
      name: "OpenAI Codex",
      models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" } },
    })

    render(() => <TestAgentHarnessSelector directory="/repo" sessionId="new" />)

    await waitFor(() => expect(resolveDefaultCalls).toContainEqual({
      supportedHarnesses: expect.arrayContaining([{ kind: "native", harnessId: "opencode" }]),
      eligibleModels: [{ providerID: "openai-codex", modelID: "gpt-5.5" }],
      connectedProviderIDs: ["openai-codex"],
      providerDefaults: { "openai-codex": "gpt-5.5" },
    }))
  })

  test("a loaded OpenCode catalog is usable without connected credentials", async () => {
    harnessType = { kind: "native", harnessId: "opencode" }
    catalogConnected = ["opencode"]
    catalogProviders.set("opencode", {
      id: "opencode",
      name: "OpenCode Zen",
      models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
    })

    const { container } = render(() => <TestAgentHarnessSelector directory="/repo" sessionId="new" />)

    expect(noticeRow(container)).toBeNull()
    await waitFor(() => expect(setModelCalls).toEqual([{
      scope: "test-scope",
      model: { providerID: "opencode", modelID: "big-pickle" },
    }]))
  })

  test("a loaded OpenCode catalog does not demand setup when no providers are connected", () => {
    harnessType = { kind: "native", harnessId: "opencode" }
    catalogConnected = []
    catalogProviders.set("opencode", {
      id: "opencode",
      name: "OpenCode Zen",
      models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
    })

    const { container } = render(() => <TestAgentHarnessSelector />)

    expect(noticeRow(container)).toBeNull()
    expect(container.querySelector("[data-testid='model-option-big-pickle']")).not.toBeNull()
  })

})
