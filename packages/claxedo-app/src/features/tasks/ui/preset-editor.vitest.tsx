import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createEffect, createSignal } from "solid-js"
import type { HarnessReference } from "@claxedo/tasks"
import {
  PresetEditor,
  emptyPresetEditorDraft,
  type CapabilityCatalog,
  type ConfigurationEditorProps,
  type PresetEditorDraft,
} from "@claxedo/tasks/solid"

afterEach(cleanup)

const CLAUDE: HarnessReference = { id: "claude", access: "native" }
const CODEX: HarnessReference = { id: "codex", access: "native" }

const catalog: CapabilityCatalog = {
  plugins: [{ key: "src/linter", sourceId: "src", name: "linter", label: "Linter", bundledSkills: ["review"], available: true }],
  skills: [{ key: "src/review", sourceId: "src", name: "review", label: "Review", available: true }],
  loading: false,
}

/**
 * Stands in for the host's harness/model/effort control. It emits the same
 * `ConfigurationDraft` the real adapter reads back from the composer's
 * selection controller, which is the seam the editor's rules act on.
 */
function StubConfigurationEditor(props: ConfigurationEditorProps) {
  return (
    <div data-testid={`stub-${props.slot}`}>
      <span data-testid={`stub-harness-${props.slot}`}>{props.configuration.harness?.id ?? "none"}</span>
      <span data-testid={`stub-model-${props.slot}`}>{props.configuration.model?.modelID ?? "none"}</span>
      <span data-testid={`stub-effort-${props.slot}`}>{props.configuration.effort ?? "none"}</span>
      <button
        type="button"
        data-testid={`stub-pick-claude-${props.slot}`}
        onClick={() =>
          props.onChange({ harness: CLAUDE, model: { providerID: "anthropic", modelID: "sonnet" }, effort: "high" })
        }
      >
        claude
      </button>
      <button
        type="button"
        data-testid={`stub-pick-codex-${props.slot}`}
        onClick={() => props.onChange({ harness: CODEX, model: { providerID: "anthropic", modelID: "sonnet" }, effort: "high" })}
      >
        codex
      </button>
    </div>
  )
}

function mount(initial?: Partial<PresetEditorDraft>) {
  const onSubmit = vi.fn()
  const [draft, updateDraft] = createSignal({ ...emptyPresetEditorDraft(), name: "Reviewer", ...initial })
  render(() => (
    <PresetEditor
      editorKey="new"
      draft={draft()}
      onDraftChange={updateDraft}
      placements={["local", "cloud"]}
      catalog={() => catalog}
      configurationEditor={StubConfigurationEditor}
      submitLabel="Create preset"
      onSubmit={onSubmit}
      onCancel={() => {}}
    />
  ))
  return { onSubmit, draft }
}

describe("preset editor", () => {
  test("a configuration editor that reads selection state in its body is not remounted by its own selection", () => {
    const [selection, setSelection] = createSignal<HarnessReference | null>(null)
    let mounts = 0
    let effectRuns = 0
    function TrackingEditor(props: ConfigurationEditorProps) {
      mounts += 1
      const initial = selection()
      createEffect(() => {
        effectRuns += 1
        if (effectRuns > 8) throw new Error(`selection effect re-ran ${effectRuns} times`)
        const harness = selection()
        if (harness) props.onChange({ harness, model: null, effort: null })
      })
      return (
        <button type="button" data-testid="tracking-pick" onClick={() => setSelection(CLAUDE)}>
          {initial?.id ?? "none"}
        </button>
      )
    }
    const [draft, updateDraft] = createSignal(emptyPresetEditorDraft())
    render(() => (
      <PresetEditor
        editorKey="new"
        draft={draft()}
        onDraftChange={updateDraft}
        placements={["local"]}
        catalog={() => catalog}
        configurationEditor={TrackingEditor}
        submitLabel="Create preset"
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    ))

    fireEvent.click(screen.getByTestId("tracking-pick"))

    expect(draft().configurations.primary?.harness).toEqual(CLAUDE)
    expect(mounts).toBe(1)
    expect(effectRuns).toBe(2)
  })

  test("a harness change clears the model and effort the previous harness resolved", () => {
    mount()

    fireEvent.click(screen.getByTestId("stub-pick-claude-primary"))
    expect(screen.getByTestId("stub-model-primary").textContent).toBe("sonnet")
    expect(screen.getByTestId("stub-effort-primary").textContent).toBe("high")

    fireEvent.click(screen.getByTestId("stub-pick-codex-primary"))

    expect(screen.getByTestId("stub-harness-primary").textContent).toBe("codex")
    expect(screen.getByTestId("stub-model-primary").textContent).toBe("none")
    expect(screen.getByTestId("stub-effort-primary").textContent).toBe("none")
  })

  test("submitting after a harness change is refused by name rather than sending the previous model", () => {
    const { onSubmit } = mount()

    fireEvent.click(screen.getByTestId("stub-pick-claude-primary"))
    fireEvent.click(screen.getByTestId("stub-pick-codex-primary"))
    fireEvent.submit(screen.getByTestId("preset-editor"))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId("preset-editor-error-primary-model").textContent).toContain("Choose a model")
  })

  test("a complete configuration submits the draft the user actually chose", () => {
    const { onSubmit } = mount()

    fireEvent.click(screen.getByTestId("stub-pick-claude-primary"))
    fireEvent.submit(screen.getByTestId("preset-editor"))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].configurations.primary).toEqual({
      harness: CLAUDE,
      model: { providerID: "anthropic", modelID: "sonnet" },
      effort: "high",
    })
  })

  test("Local offers no selection controls and says it inherits this machine's configuration", () => {
    mount({ placement: "local" })

    expect(screen.getByTestId("preset-editor-local-capabilities").textContent).toBe("Use local skills and plugins")
    expect(screen.queryByTestId("preset-editor-cloud-capabilities")).toBeNull()
    expect(screen.queryByTestId("preset-editor-plugins")).toBeNull()
  })

  test("Cloud shows the installed catalog and records the exact selection", () => {
    const { draft } = mount({ placement: "cloud" })

    expect(screen.getByTestId("preset-editor-cloud-capabilities")).toBeTruthy()
    fireEvent.click(screen.getByTestId("preset-editor-plugin-src/linter"))

    expect(draft().plugins).toEqual([{ sourceId: "src", pluginName: "linter" }])
  })

  test("an optional slot appears only once it is enabled", () => {
    mount()

    expect(screen.queryByTestId("preset-editor-configuration-planning")).toBeNull()
    fireEvent.click(screen.getByTestId("preset-editor-slot-planning"))

    expect(screen.getByTestId("preset-editor-configuration-planning")).toBeTruthy()
  })
})
