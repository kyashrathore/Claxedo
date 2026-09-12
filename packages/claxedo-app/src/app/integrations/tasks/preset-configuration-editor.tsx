import { Show, createEffect, createMemo, onMount } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { HarnessReference } from "@claxedo/tasks"
import type { ConfigurationEditorProps } from "@claxedo/tasks/solid"
import { AgentHarnessSelector } from "@/features/session/ui/controls/agent-harness-selector"
import { usePromptHarnessControllersOptional } from "@/features/session/composer/ui/harness-controller"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import {
  NATIVE_HARNESS_IDS,
  connectionHarness,
  nativeHarness,
  type HarnessSelection,
} from "@/platform/identity/harness-selection"

export function harnessReferenceOf(selection: HarnessSelection): HarnessReference {
  return selection.kind === "native"
    ? { id: selection.harnessId, access: "native" }
    : { id: selection.connectionId, access: "connection" }
}

export function harnessSelectionOf(reference: HarnessReference): HarnessSelection | undefined {
  if (reference.access === "connection") return connectionHarness(reference.id)
  const native = NATIVE_HARNESS_IDS.find((id) => id === reference.id)
  return native ? nativeHarness(native) : undefined
}

/**
 * The composer's harness/model/effort selector, driving a preset slot.
 *
 * It runs under its own synthetic draft scope so the preset editor and an open
 * composer pane never share selection state. The workspace it reads catalogs
 * from is a representative one — a preset belongs to its owner, not to a
 * project — and every saved choice is revalidated against the real target at
 * Start preview, which is where an unavailable model is named rather than
 * swapped.
 */
export function PresetConfigurationEditor(props: ConfigurationEditorProps) {
  const controllers = usePromptHarnessControllersOptional()
  const queryOptions = useShellQueryOptions()
  const projects = useQuery(() => queryOptions.projects())
  const catalogDirectory = createMemo(() => projects.data?.[0]?.worktree)
  const scope = createMemo(() => panePreferenceScope({ draftId: `preset-editor:${props.editorKey}:${props.slot}` }))

  const controller = controllers.selection
  const snapshot = createMemo(() => controller?.read(scope()))

  onMount(() => {
    const seed = props.configuration
    if (!controller || !seed.harness) return
    const selection = harnessSelectionOf(seed.harness)
    if (!selection) return
    void controller.setHarness(scope(), selection, { directory: catalogDirectory() })
    if (seed.model) {
      void controller.setModel(scope(), { providerID: seed.model.providerID, modelID: seed.model.modelID }, { directory: catalogDirectory() })
    }
    controller.setThoughtLevel(scope(), seed.effort ?? undefined)
  })

  // Read-back, not a mirror: the controller owns the selection and this
  // reports it to the preset draft. Clearing the model when the harness
  // changes is the package's rule, applied where the draft is assembled.
  createEffect(() => {
    const current = snapshot()
    if (!current) return
    const harness = current.harness
    const model = current.selectedModelKey
    props.onChange({
      harness: harness ? harnessReferenceOf(harness) : null,
      model: model ? { providerID: model.providerID, modelID: model.modelID } : null,
      effort: current.selectedThoughtLevel ?? null,
    })
  })

  return (
    <Show when={controller} fallback={<p class="tsk-error">The model selector is unavailable in this build.</p>}>
      {(selection) => (
        <div data-testid={`preset-configuration-${props.slot}`}>
          <AgentHarnessSelector
            harnessController={selection()}
            draftId={`preset-editor:${props.editorKey}:${props.slot}`}
            directory={catalogDirectory()}
            active={!props.disabled}
          />
        </div>
      )}
    </Show>
  )
}
