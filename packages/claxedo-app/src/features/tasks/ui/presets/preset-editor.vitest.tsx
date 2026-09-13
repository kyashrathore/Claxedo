import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { createEffect, createSignal } from "solid-js"
import type { HarnessReference } from "@claxedo/tasks"
import {
  emptyPresetEditorDraft,
  parsePresetEditorDraft,
  type ConfigurationEditorProps,
  type PresetEditorDraft,
} from "../../preset-editor-model"
import { type CapabilityCatalog } from "../../view-model"
import { PresetEditor } from "./preset-editor"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("../shared/test-support/host-controls")).dropdownMenuDouble())
vi.mock("@opencode-ai/ui/select", async () => (await import("../shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

const CLAUDE: HarnessReference = { id: "claude", access: "native" }
const CODEX: HarnessReference = { id: "codex", access: "native" }

const catalog: CapabilityCatalog = {
  plugins: [{ key: "src/linter", sourceId: "src", name: "linter", label: "Linter", bundledSkills: ["review"], available: true }],
  skills: [{ key: "src/review", sourceId: "src", name: "review", label: "Review", available: true }],
  loading: false,
}

/** The host's prose editor, as the plain textarea the detector falls back to. */
const StubProseEditor = (props: {
  value: string
  testId: string
  ariaLabel: string
  placeholder: string
  onChange: (value: string) => void
}) => (
  <textarea
    data-testid={props.testId}
    aria-label={props.ariaLabel}
    placeholder={props.placeholder}
    value={props.value}
    onInput={(event) => props.onChange(event.currentTarget.value)}
  />
)

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
      proseEditor={StubProseEditor}
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
        proseEditor={StubProseEditor}
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

    expect(screen.getByTestId("preset-editor-capability-guarantee").textContent).toContain(
      "Uses this machine's current skills and plugins",
    )
    expect(screen.queryByTestId("preset-editor-cloud-capabilities")).toBeNull()
    expect(screen.queryByTestId("preset-editor-plugins")).toBeNull()
  })

  // The promise is the low-level design's and no wider: it covers registered
  // optional capabilities and their credentials, not the repository, the shell
  // or the network.
  test("Local says the selection it hides is not enforced there", () => {
    mount({ placement: "local" })

    const notice = screen.getByTestId("preset-editor-capability-guarantee").textContent ?? ""
    expect(notice).toContain("Uses this machine's current skills and plugins")
    expect(notice).toContain("not enforced for local sessions")
  })

  test("Cloud scopes the selected-only promise to capabilities and credentials", () => {
    mount({ placement: "cloud" })

    const notice = screen.getByTestId("preset-editor-capability-guarantee").textContent ?? ""
    expect(notice).toContain("Only the selected plugins and skills are installed")
    expect(notice).toContain("only their credentials are brokered")
    expect(notice).toContain("repository, shell and network still follow the host's policy")
  })

  // Both kinds are picked through one list and one toggle, and the contract
  // spells the name per kind: a plugin is saved as `pluginName`, a skill as
  // `skillName`, from the same `{ sourceId, name }` the picker records.
  test("Cloud shows the installed catalog and saves each selection under its own name", () => {
    const { draft } = mount({ placement: "cloud" })

    expect(screen.getByTestId("preset-editor-cloud-capabilities")).toBeTruthy()
    fireEvent.click(within(screen.getByTestId("preset-editor-plugin-src/linter")).getByRole("checkbox"))
    fireEvent.click(within(screen.getByTestId("preset-editor-skill-src/review")).getByRole("checkbox"))
    fireEvent.click(screen.getByTestId("stub-pick-claude-primary"))

    expect(draft().plugins).toEqual([{ sourceId: "src", name: "linter" }])
    expect(draft().skills).toEqual([{ sourceId: "src", name: "review" }])

    const parsed = parsePresetEditorDraft(draft())
    expect(parsed.ok && parsed.draft.execution).toEqual({
      placement: "cloud",
      capabilities: {
        mode: "selected",
        plugins: [{ sourceId: "src", pluginName: "linter" }],
        skills: [{ sourceId: "src", skillName: "review" }],
      },
    })
  })

  test("an optional slot appears only once it is enabled", () => {
    mount()

    expect(screen.queryByTestId("preset-editor-configuration-planning")).toBeNull()
    fireEvent.click(within(screen.getByTestId("preset-editor-slot-planning")).getByRole("checkbox"))

    expect(screen.getByTestId("preset-editor-configuration-planning")).toBeTruthy()
  })
})
