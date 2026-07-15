import type { CommandResult, ExecutionCapabilities, StreamDto, WorkGraphDefaultsDto } from "@claxedo/workgraph/contracts"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WorkGraphApiError } from "../api"
import { StreamSettingsDialog, WorkGraphSettingsView } from "./settings-dialogs"

afterEach(cleanup)

const defaultsDto = {
  recordType: "workgraph",
  schemaVersion: 1,
  ownerUserId: "user_1",
  version: 3,
  createdAt: 1,
  updatedAt: 1,
  provenance: { actor: { type: "user", id: "user_1" } },
  id: "wg_1",
  defaults: {
    execution: {
      environment: { kind: "hosted_workspace" },
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      harness: "opencode",
      agent: "build",
      effort: "high",
      tools: ["read", "edit"],
    },
    recap: {},
  },
} as WorkGraphDefaultsDto

/** Same shape with an empty persisted profile; the panel fills it from the catalog. */
const emptyDefaultsDto = { ...defaultsDto, defaults: { execution: {}, recap: {} } } as WorkGraphDefaultsDto

/** A harness + model override only, so clearing the model leaves nothing stale behind. */
const modelDefaultsDto = {
  ...defaultsDto,
  defaults: { execution: { harness: "opencode", model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" } }, recap: {} },
} as WorkGraphDefaultsDto

/** A harness the catalog does not advertise — a stale selection the catalog must reject. */
const staleDefaultsDto = { ...defaultsDto, defaults: { execution: { harness: "ghost" }, recap: {} } } as WorkGraphDefaultsDto

// The exact ExecutionCapabilities the backend advertises. `hosted_workspace` takes a
// remote URL and picks its base revision from the advertised list; `local_worktree`
// requires a repository whose base revision is typed free-text. Agents, models, tools
// are scoped to their harness/provider, and effort to the selected model.
const capabilities = {
  schemaVersion: 1,
  organizationId: "org_1",
  ownerUserId: "user_1",
  catalogRevision: "c".repeat(64),
  observedAt: 0,
  expiresAt: 300_000,
  environments: [
    { kind: "hosted_workspace", repositoryRequired: false, remoteUrlInput: true, baseRevisionInput: false },
    { kind: "local_worktree", repositoryRequired: true, remoteUrlInput: false, baseRevisionInput: true },
  ],
  harnesses: [{ id: "opencode" }, { id: "pi" }, { id: "codex-app-server" }],
  agents: [
    { harnessId: "opencode", id: "build", label: "Build" },
    { harnessId: "pi", id: "plan", label: "Plan" },
    { harnessId: "codex-app-server", id: "build", label: "Build" },
  ],
  models: [
    { harnessId: "opencode", providerId: "anthropic", modelId: "claude-sonnet-4-5", label: "Sonnet", efforts: ["high", "low"] },
    { harnessId: "opencode", providerId: "openai", modelId: "gpt-5", label: "GPT-5", efforts: ["medium", "high"] },
    { harnessId: "pi", providerId: "google", modelId: "gemini-2.5-pro", label: "Gemini 2.5 Pro", efforts: ["high"] },
    { harnessId: "codex-app-server", providerId: "codex-app-server", modelId: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "high"] },
  ],
  tools: [
    { harnessId: "opencode", id: "read" },
    { harnessId: "opencode", id: "edit" },
    { harnessId: "pi", id: "shell" },
  ],
  repository: { remoteUrl: "https://example.com/acme/repo.git", baseRevisions: ["main", "dev"] },
  connections: [{ id: "conn_1", integrationId: "github", scope: "team", accountLabel: "acme", grantedCapabilities: ["repo"] }],
} as ExecutionCapabilities

const ok: CommandResult = { ok: true, operationId: "op_1", cursor: "c_1", value: {} } as CommandResult

describe("WorkGraphSettingsView", () => {
  test("fills an empty WorkGraph profile with catalog defaults", async () => {
    const source = { defaults: vi.fn(async () => emptyDefaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    // The WorkGraph panel starts usable without an inheritance sentinel.
    expect(screen.queryByText("Inherit")).toBeNull()
    expect(screen.queryByLabelText("Environment")).toBeNull()
    expect(screen.queryByLabelText("Base revision")).toBeNull()
    expect((screen.getByLabelText("Harness") as HTMLSelectElement).value).toBe("opencode")
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("build")
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("anthropic")
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("anthropic/claude-sonnet-4-5")
    expect((screen.getByLabelText("Effort") as HTMLSelectElement).value).toBe("high")
    expect(screen.queryByText("Permitted tools")).toBeNull()

    await fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalled())
    const [, payload] = source.saveDefaults.mock.calls[0]!
    expect(payload.execution.model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-4-5" })
    expect(payload.execution.tools).toEqual(["read", "edit"])
    expect(payload.execution.connectionIds).toEqual([])
    expect(payload.execution).not.toHaveProperty("environment")
    expect(payload.execution).not.toHaveProperty("repository")
  })

  test("a missing catalog makes every field read-only and blocks Save", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    // No selects at all — the loaded values render read-only with an explicit note.
    expect(screen.queryByLabelText("Environment")).toBeNull()
    expect(screen.getAllByText("Capability catalog not connected").length).toBeGreaterThan(0)
    expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument()
    // Save is blocked and the footer explains why.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("read-only")
  })

  test("renders the exact capability resource error verbatim and blocks Save — not a generic no-catalog", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    const error = new WorkGraphApiError("execution_capabilities_unavailable", "Execution runtime is unavailable.")
    render(() => <WorkGraphSettingsView active={true} source={source} capabilitiesError={error} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    // The real WorkGraphApiError message renders in the fixed footer; the form stays
    // fail-closed (no editable selects) rather than reducing to a generic message.
    expect(screen.getByRole("alert")).toHaveTextContent("Execution runtime is unavailable.")
    expect(screen.queryByLabelText("Environment")).toBeNull()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  test("an in-flight capability load is explicit and fail-closed", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilitiesLoading={true} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    // Loading is not silently treated as a connected empty catalog: it is stated and Save is blocked.
    expect(screen.getByRole("alert")).toHaveTextContent(/Loading the capability catalog/)
    expect(screen.queryByLabelText("Environment")).toBeNull()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  test("a selection the catalog no longer advertises blocks Save with a stale note", async () => {
    const source = { defaults: vi.fn(async () => staleDefaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    // The stale value is preserved and surfaced (the catalog offers no matching option,
    // so the note carries it) and Save stays blocked until it is fixed.
    expect(screen.getByText(/“ghost” isn't offered by the catalog/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  test("narrows agent, provider, model, and effort across every advertised harness", async () => {
    const source = { defaults: vi.fn(async () => emptyDefaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    expect(screen.getByRole("option", { name: "Pi" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Codex App Server" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Openai" })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } })
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("openai/gpt-5")
    expect(screen.getByRole("option", { name: "medium" })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "codex-app-server" } })
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("build")
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("codex-app-server")
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("codex-app-server/gpt-5.5")
    expect(screen.queryByLabelText("Connections override")).toBeNull()

    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "pi" } })
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("plan")
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("google")
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("google/gemini-2.5-pro")
    expect(screen.queryByRole("option", { name: "Sonnet" })).toBeNull()

  })

  test("saves with the loaded version (CAS)", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalled())
    const [version, payload] = source.saveDefaults.mock.calls[0]!
    expect(version).toBe(3)
    expect(payload.execution).not.toHaveProperty("integration")
  })

  test("refetches after a successful save so the next save uses the latest version", async () => {
    const refreshed = { ...defaultsDto, version: 4 } as WorkGraphDefaultsDto
    const source = {
      defaults: vi.fn().mockResolvedValueOnce(defaultsDto).mockResolvedValueOnce(refreshed),
      saveDefaults: vi.fn(async () => ok),
    }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    await fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(source.defaults).toHaveBeenCalledTimes(2))
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalledTimes(2))
    expect(source.saveDefaults.mock.calls.map(([version]) => version)).toEqual([3, 4])
  })

  test("clearing a required WorkGraph model blocks Save", async () => {
    const source = { defaults: vi.fn(async () => modelDefaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } })
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent(/complete default execution profile/)
  })

  test("has no inner Execution/Recap tabs and pins the actions outside the scroll region", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    const { container } = render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })
    // No nested tab strip anywhere, and recap is not a WorkGraph-level setting.
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByRole("tablist")).toBeNull()
    expect(screen.queryByText("Recap behavior")).toBeNull()
    // The Save/Cancel footer lives outside the scrolling field region.
    expect(container.querySelector(".workgraph-settings-scroll")).not.toBeNull()
    const save = screen.getByRole("button", { name: "Save" })
    expect(save.closest(".workgraph-settings-scroll")).toBeNull()
    expect(save.closest(".workgraph-settings-footer")).not.toBeNull()
  })

  test("preserves the loaded recap object unchanged when saving execution defaults", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalled())
    const [, payload] = source.saveDefaults.mock.calls[0]!
    // The exact loaded recap object is passed through — never synthesized or substituted.
    expect(payload.recap).toBe(defaultsDto.defaults.recap)
  })

  test("keeps harness tools automatic while Connections remain explicit", async () => {
    const source = { defaults: vi.fn(async () => emptyDefaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    expect(screen.queryByText("Permitted tools")).toBeNull()
    expect(screen.queryByLabelText("Permitted tools override")).toBeNull()
    fireEvent.click(screen.getByRole("checkbox", { name: "acme" }))
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalled())
    const [, payload] = source.saveDefaults.mock.calls[0]!
    expect(payload.execution.tools).toEqual(["read", "edit"])
    expect(payload.execution.connectionIds).toEqual(["conn_1"])
  })

  test("surfaces a version conflict", async () => {
    const conflict = { ok: false, operationId: "op_1", cursor: "c_1", error: { code: "version_conflict", message: "conflict", retryable: false } } as CommandResult
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => conflict) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    await fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere")
  })
})

const streamDto = {
  recordType: "stream",
  schemaVersion: 1,
  ownerUserId: "user_1",
  version: 7,
  createdAt: 1,
  updatedAt: 1,
  provenance: { actor: { type: "user", id: "user_1" } },
  id: "stream_1",
  title: "Ship Claxedo cloud",
  lifecycleState: "active",
  visibility: "visible",
  pinned: false,
  executionDefaults: {
    environment: { kind: "local_worktree", directory: "/repo" },
    repository: { baseRevision: "HEAD" },
  },
  recapDefaults: {},
  activity: { lastActivityAt: 1, recapDueAt: 2 },
  durableEffectCount: 0,
  sourceRevisionRefs: [],
} as StreamDto

describe("StreamSettingsDialog", () => {
  test("uses known projects and the shared directory picker for a local Stream", async () => {
    const choose = vi.fn(async () => "/repo/new")
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save: vi.fn(async () => ok) }
    render(() => (
      <StreamSettingsDialog
        open={true}
        onClose={() => {}}
        stream={streamDto}
        source={source}
        capabilities={capabilities}
        localProjects={[{ value: "/repo", label: "Current project" }]}
        onChooseLocalProject={choose}
      />
    ))
    await screen.findByText("Stream settings")

    const project = screen.getByLabelText("Project directory") as HTMLSelectElement
    expect(project.value).toBe("/repo")
    expect(screen.getByRole("option", { name: "Current project" })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }))
    await waitFor(() => expect(project.value).toBe("/repo/new"))
  })

  test("saves execution and recap atomically at one expected version", async () => {
    const save = vi.fn(async () => ok)
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilities={capabilities} />)
    await screen.findByText("Stream settings")

    // Harness is advertised regardless of environment, so it is a safe field to edit here.
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } })
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [streamId, version, settings] = save.mock.calls[0]!
    expect(streamId).toBe("stream_1")
    expect(version).toBe(7)
    expect(settings.execution.harness).toBe("opencode")
    expect(settings.recap).toBeDefined()
  })

  test("distinguishes Stream-owned targets from WorkGraph profile defaults", async () => {
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save: vi.fn(async () => ok) }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilities={capabilities} />)
    await screen.findByText("Stream settings")

    expect(screen.queryByText("Inherit")).toBeNull()
    expect(screen.getAllByText("Select…").length).toBeGreaterThan(0)
    expect(screen.getByText("WorkGraph default: opencode")).toBeInTheDocument()
  })

  test("shows Execution and Recap behavior sections with no inner tabs", async () => {
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save: vi.fn(async () => ok) }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilities={capabilities} />)
    await screen.findByText("Stream settings")
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.getByText("Execution")).toBeInTheDocument()
    expect(screen.getByText("Recap behavior")).toBeInTheDocument()
  })

  test("saves all harness tools automatically and selected Connections", async () => {
    const save = vi.fn(async () => ok)
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilities={capabilities} />)
    await screen.findByText("Stream settings")

    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } })
    fireEvent.click(screen.getByRole("checkbox", { name: "acme" }))
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [, , settings] = save.mock.calls[0]!
    expect(settings.execution.tools).toEqual(["read", "edit"])
    expect(settings.execution.connectionIds).toEqual(["conn_1"])
  })

  test("clears OpenCode Connections when switching to a harness that owns its tools", async () => {
    const source = { defaults: vi.fn(async () => emptyDefaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    fireEvent.click(screen.getByRole("checkbox", { name: "acme" }))
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "codex-app-server" } })
    expect(screen.queryByLabelText("Connections override")).toBeNull()
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalledTimes(1))
    const [, settings] = source.saveDefaults.mock.calls[0]!
    expect(settings.execution.connectionIds).toEqual([])
    expect(settings.execution.tools).toEqual([])
  })

  test("defaults empty Stream Recap settings from inherited execution with eight quiet hours", async () => {
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save: vi.fn(async () => ok) }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilities={capabilities} />)
    await screen.findByText("Stream settings")

    expect((screen.getByLabelText("Recap provider") as HTMLSelectElement).value).toBe("anthropic")
    expect((screen.getByLabelText("Recap model") as HTMLSelectElement).value).toBe("anthropic/claude-sonnet-4-5")
    expect((screen.getByLabelText("Recap effort") as HTMLSelectElement).value).toBe("high")
    expect((screen.getByLabelText("Quiet hours") as HTMLInputElement).value).toBe("8")
  })

  test("allows an explicit empty Connections override without exposing tool permissions", async () => {
    const save = vi.fn(async () => ok)
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilities={capabilities} />)
    await screen.findByText("Stream settings")

    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } })
    fireEvent.change(screen.getByLabelText("Connections override"), { target: { value: "explicit" } })
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [, , settings] = save.mock.calls[0]!
    expect(settings.execution.tools).toEqual(["read", "edit"])
    expect(settings.execution.connectionIds).toEqual([])
  })

  test("populates the body when opened after mounting closed (reactive resource gate)", async () => {
    // The dialog is mounted once and toggled open later (see workgraph-content.tsx).
    // The inherited-defaults resource must be gated by a reactive SOURCE, not by a
    // condition inside a single-arg fetcher — otherwise the fetch never re-runs on
    // open and the dialog body stays blank.
    const workgraphDefaults = vi.fn(async () => defaultsDto)
    const source = { workgraphDefaults, save: vi.fn(async () => ok) }
    const [open, setOpen] = createSignal(false)
    render(() => <StreamSettingsDialog open={open()} onClose={() => setOpen(false)} stream={streamDto} source={source} capabilities={capabilities} />)

    // Closed: the gate withholds the fetch and no body renders.
    expect(workgraphDefaults).not.toHaveBeenCalled()
    expect(screen.queryByText("Execution")).toBeNull()

    // Opening flips the source, so the fetch runs and the body populates.
    setOpen(true)
    expect(await screen.findByText("Stream settings")).toBeInTheDocument()
    expect(await screen.findByText("Execution")).toBeInTheDocument()
    await waitFor(() => expect(workgraphDefaults).toHaveBeenCalled())
  })

  test("surfaces the exact capability resource error in the footer and blocks Save", async () => {
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save: vi.fn(async () => ok) }
    const error = new WorkGraphApiError("execution_capabilities_unavailable", "Execution runtime is unavailable.")
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilitiesError={error} />)
    await screen.findByText("Stream settings")

    // The same exact-error contract applies to the per-stream form.
    expect(screen.getByRole("alert")).toHaveTextContent("Execution runtime is unavailable.")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  test("gives recap controls accessible names distinct from the execution controls", async () => {
    // With the catalog present, execution and recap each render a Model and Effort
    // select; their accessible names must be unique so assistive tech (and tests)
    // can tell them apart.
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save: vi.fn(async () => ok) }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} capabilities={capabilities} />)
    await screen.findByText("Recap behavior")

    expect(screen.getByLabelText("Model")).toBeInTheDocument()
    expect(screen.getByLabelText("Effort")).toBeInTheDocument()
    expect(screen.getByLabelText("Recap model")).toBeInTheDocument()
    expect(screen.getByLabelText("Recap effort")).toBeInTheDocument()
  })
})
