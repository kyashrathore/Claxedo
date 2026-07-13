import type { CommandResult, StreamDto, WorkGraphDefaultsDto } from "@claxedo/workgraph/contracts"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { SettingsCapabilities } from "./settings-capabilities"
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
      isolation: "stream",
      cleanup: "destroy_on_close",
      integration: "pull_request",
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      harness: "opencode",
      agent: "build",
      effort: "high",
      tools: ["read", "edit"],
    },
    recap: {},
  },
} as WorkGraphDefaultsDto

const capabilities: SettingsCapabilities = {
  harnesses: ["opencode"],
  agents: ["build"],
  models: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5", label: "Sonnet" }],
  efforts: ["high"],
  tools: ["read", "edit"],
}

const ok: CommandResult = { ok: true, operationId: "op_1", cursor: "c_1", value: {} } as CommandResult

describe("WorkGraphSettingsView", () => {
  test("keeps capability fields typed-prop-driven and reports the missing catalog when absent", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} />)

    expect(await screen.findByRole("heading", { name: "WorkGraph settings" })).toBeInTheDocument()
    // Model has no catalog available → explicit unavailable note, current value shown, no invented options.
    expect(screen.getByText(/model capability API not connected/)).toBeInTheDocument()
    expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument()
    // Enum fields (contract-defined) are always editable.
    expect(screen.getByLabelText("Environment")).toBeInTheDocument()
    expect(screen.getByLabelText("Isolation")).toBeInTheDocument()
  })

  test("saves with the loaded version (CAS)", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    fireEvent.change(screen.getByLabelText("Integration"), { target: { value: "manual" } })
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalled())
    const [version, payload] = source.saveDefaults.mock.calls[0]!
    expect(version).toBe(3)
    expect(payload.execution.integration).toBe("manual")
  })

  test("clearing the model override truly clears it when the catalog is available", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    render(() => <WorkGraphSettingsView active={true} source={source} capabilities={capabilities} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    // With the catalog present the model is an editable select; setting it back to
    // "Inherit" (empty) must drop the override entirely — including the model.
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } })
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalled())
    const [, payload] = source.saveDefaults.mock.calls[0]!
    expect(payload.execution.model).toBeUndefined()
  })

  test("has no inner Execution/Recap tabs and pins the actions outside the scroll region", async () => {
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => ok) }
    const { container } = render(() => <WorkGraphSettingsView active={true} source={source} />)
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
    render(() => <WorkGraphSettingsView active={true} source={source} />)
    await screen.findByRole("heading", { name: "WorkGraph settings" })

    fireEvent.change(screen.getByLabelText("Integration"), { target: { value: "manual" } })
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(source.saveDefaults).toHaveBeenCalled())
    const [, payload] = source.saveDefaults.mock.calls[0]!
    // The exact loaded recap object is passed through — never synthesized or substituted.
    expect(payload.recap).toBe(defaultsDto.defaults.recap)
  })

  test("surfaces a version conflict", async () => {
    const conflict = { ok: false, operationId: "op_1", cursor: "c_1", error: { code: "version_conflict", message: "conflict", retryable: false } } as CommandResult
    const source = { defaults: vi.fn(async () => defaultsDto), saveDefaults: vi.fn(async () => conflict) }
    render(() => <WorkGraphSettingsView active={true} source={source} />)
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
  executionDefaults: {},
  recapDefaults: {},
  activity: { lastActivityAt: 1, recapDueAt: 2 },
  durableEffectCount: 0,
  sourceRevisionRefs: [],
} as StreamDto

describe("StreamSettingsDialog", () => {
  test("saves execution and recap atomically at one expected version", async () => {
    const save = vi.fn(async () => ok)
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} />)
    await screen.findByText("Stream settings")

    fireEvent.change(screen.getByLabelText("Integration"), { target: { value: "manual" } })
    await fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [streamId, version, settings] = save.mock.calls[0]!
    expect(streamId).toBe("stream_1")
    expect(version).toBe(7)
    expect(settings.execution.integration).toBe("manual")
    expect(settings.recap).toBeDefined()
  })

  test("shows Execution override and Recap behavior sections with no inner tabs", async () => {
    const source = { workgraphDefaults: vi.fn(async () => defaultsDto), save: vi.fn(async () => ok) }
    render(() => <StreamSettingsDialog open={true} onClose={() => {}} stream={streamDto} source={source} />)
    await screen.findByText("Stream settings")
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.getByText("Execution override")).toBeInTheDocument()
    expect(screen.getByText("Recap behavior")).toBeInTheDocument()
  })

  test("populates the body when opened after mounting closed (reactive resource gate)", async () => {
    // The dialog is mounted once and toggled open later (see workgraph-content.tsx).
    // The inherited-defaults resource must be gated by a reactive SOURCE, not by a
    // condition inside a single-arg fetcher — otherwise the fetch never re-runs on
    // open and the dialog body stays blank.
    const workgraphDefaults = vi.fn(async () => defaultsDto)
    const source = { workgraphDefaults, save: vi.fn(async () => ok) }
    const [open, setOpen] = createSignal(false)
    render(() => <StreamSettingsDialog open={open()} onClose={() => setOpen(false)} stream={streamDto} source={source} />)

    // Closed: the gate withholds the fetch and no body renders.
    expect(workgraphDefaults).not.toHaveBeenCalled()
    expect(screen.queryByText("Execution override")).toBeNull()

    // Opening flips the source, so the fetch runs and the body populates.
    setOpen(true)
    expect(await screen.findByText("Stream settings")).toBeInTheDocument()
    expect(await screen.findByText("Execution override")).toBeInTheDocument()
    await waitFor(() => expect(workgraphDefaults).toHaveBeenCalled())
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
