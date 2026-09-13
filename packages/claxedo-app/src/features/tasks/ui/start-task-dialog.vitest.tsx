import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import type { Preset, StartPreview } from "@claxedo/tasks"
import { StartTaskDialog, type StartDraft, type StartPreviewState } from "@claxedo/tasks/solid"

afterEach(cleanup)

const preset: Preset = {
  id: "pre_1",
  revision: 1,
  scopeId: "local",
  ownerId: "local",
  name: "Reviewer",
  instructions: "",
  execution: { placement: "local", capabilities: { mode: "inherit-local" } },
  configurations: {
    primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "sonnet" }, effort: null },
  },
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
}

function preview(overrides: Partial<StartPreview> = {}): StartPreview {
  return {
    digest: "digest_1",
    expiresAt: 10_000,
    placement: "local",
    slot: "primary",
    attempt: 1,
    configuration: preset.configurations.primary,
    capabilities: { mode: "inherit-local" },
    available: true,
    blockers: [],
    currentSession: null,
    previousTranscriptReadable: false,
    destinationDescription: "This machine, /repo/importer",
    ...overrides,
  }
}

function mount(input: { presets?: readonly Preset[]; preview: StartPreviewState }) {
  const onStart = vi.fn()
  const onOpenPresetSettings = vi.fn()
  const [draft, updateDraft] = createSignal<StartDraft>({
    presetId: (input.presets ?? [preset])[0]?.id ?? null,
    slot: "primary",
    handoffText: "",
    continueFromPrevious: false,
  })
  render(() => (
    <StartTaskDialog
      taskTitle="Ship the importer"
      attempt={1}
      presets={input.presets ?? [preset]}
      draft={draft()}
      preview={input.preview}
      onDraftChange={updateDraft}
      onOpenPresetSettings={onOpenPresetSettings}
      onStart={onStart}
      onCancel={() => {}}
    />
  ))
  return { onStart, onOpenPresetSettings, draft }
}

describe("start task dialog", () => {
  test("a failed preview keeps the draft and refuses to start", () => {
    const { onStart, draft } = mount({ preview: { status: "ready", preview: preview() } })

    fireEvent.input(screen.getByTestId("start-task-handoff"), { target: { value: "pick up where I left off" } })
    expect(draft().handoffText).toBe("pick up where I left off")

    cleanup()
    const failed = mount({ preview: { status: "error", message: "The source ref is unavailable." } })
    fireEvent.input(screen.getByTestId("start-task-handoff"), { target: { value: "pick up where I left off" } })

    expect(screen.getByTestId("start-task-preview-error").textContent).toBe("The source ref is unavailable.")
    expect(failed.draft().handoffText).toBe("pick up where I left off")
    expect(screen.getByTestId("start-task-submit")).toBeDisabled()
    fireEvent.click(screen.getByTestId("start-task-submit"))
    expect(failed.onStart).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
  })

  test("a preview whose input has changed keeps its panel and refuses Start", () => {
    const { onStart } = mount({
      preview: { status: "ready", preview: preview({ previousTranscriptReadable: true }), refreshing: true },
    })

    expect(screen.getByTestId("start-task-continue")).toBeTruthy()
    expect(screen.getByTestId("start-task-preview-resolving")).toBeTruthy()
    expect(screen.getByTestId("start-task-submit")).toBeDisabled()
    fireEvent.click(screen.getByTestId("start-task-submit"))
    expect(onStart).not.toHaveBeenCalled()
  })

  test("with no presets saved there is no default: the dialog points at Settings", () => {
    const { onOpenPresetSettings, onStart } = mount({ presets: [], preview: { status: "idle" } })

    expect(screen.getByTestId("start-task-no-presets")).toBeTruthy()
    expect(screen.queryByTestId("start-task-preset")).toBeNull()
    fireEvent.click(screen.getByTestId("start-task-preset-settings"))

    expect(onOpenPresetSettings).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  test("the chooser lists the saved presets and offers Settings beside them", () => {
    const { onOpenPresetSettings } = mount({ preview: { status: "ready", preview: preview() } })

    expect(screen.getByRole("option", { name: preset.name })).toBeTruthy()
    fireEvent.click(screen.getByTestId("start-task-preset-settings"))

    expect(onOpenPresetSettings).toHaveBeenCalledTimes(1)
  })

  test("an unavailable preview names its blockers and blocks Start", () => {
    const { onStart } = mount({
      preview: {
        status: "ready",
        preview: preview({ available: false, blockers: [{ code: "model_unavailable", detail: "sonnet is not connected here." }] }),
      },
    })

    expect(screen.getByTestId("start-task-blocker-model_unavailable").textContent).toBe("sonnet is not connected here.")
    expect(screen.getByTestId("start-task-submit")).toBeDisabled()
    fireEvent.click(screen.getByTestId("start-task-submit"))
    expect(onStart).not.toHaveBeenCalled()
  })

  test("a resolved preview starts with the settings it showed", () => {
    const { onStart } = mount({ preview: { status: "ready", preview: preview() } })

    expect(screen.getByTestId("start-task-preview-capabilities").textContent).toContain("current skills and plugins")
    fireEvent.click(screen.getByTestId("start-task-submit"))

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  test("the preview states the guarantee the resolved placement actually makes", () => {
    mount({ preview: { status: "ready", preview: preview() } })
    expect(screen.getByTestId("start-task-preview-capabilities").textContent).toContain(
      "not enforced for local sessions",
    )

    cleanup()
    mount({
      preview: {
        status: "ready",
        preview: {
          ...preview(),
          placement: "cloud",
          capabilities: { mode: "selected", plugins: [], skills: [] },
        },
      },
    })

    const notice = screen.getByTestId("start-task-preview-capabilities").textContent ?? ""
    expect(notice).toContain("only their credentials are brokered")
    expect(notice).toContain("repository, shell and network still follow the host's policy")
  })
})
