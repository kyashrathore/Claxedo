import { Show, type Accessor } from "solid-js"
import { useComposerText } from "../text"
import { ModelList, type PickerState } from "./model-list"
import { SectionHeader, SectionPanel, type HarnessPickerSection } from "./harness-picker-section"

export type ModelLoadFailure = {
  message: string
  detail?: string
  action?: { label: string; run: () => void }
}

export type ModelSectionProps = {
  model: Accessor<PickerState>
  modelLabel: Accessor<string>
  modelLoading: Accessor<boolean>
  modelDisabled: Accessor<boolean>
  modelError?: Accessor<ModelLoadFailure | undefined>
  modelsEmpty?: Accessor<ModelLoadFailure | undefined>
}

export function HarnessPickerModelSection(props: {
  picker: ModelSectionProps
  section: Accessor<HarnessPickerSection | null>
  onToggle: () => void
  onSelect: () => void
}) {
  const t = useComposerText()
  const empty = () => (props.picker.model().list().length > 0 ? undefined : props.picker.modelsEmpty?.())
  return (
    <>
      <SectionHeader
        label={t("composer.picker.model")}
        value={props.picker.modelLabel()}
        loading={props.picker.modelLoading()}
        expanded={props.section() === "model" && !props.picker.modelLoading()}
        onToggle={props.onToggle}
      />
      <Show when={props.section() === "model" && !props.picker.modelLoading()}>
        <SectionPanel class="flex min-h-0 flex-1 flex-col">
          <Show
            when={props.picker.modelError?.()}
            fallback={
              <Show when={empty()} fallback={<ModelList model={props.picker.model()} tooltips={false} onSelect={props.onSelect} />}>
                {(failure) => <ModelNotice critical={false} failure={failure()} />}
              </Show>
            }
          >
            {(failure) => <ModelNotice critical failure={failure()} />}
          </Show>
        </SectionPanel>
      </Show>
    </>
  )
}

function ModelNotice(props: { failure: ModelLoadFailure; critical: boolean }) {
  return (
    <div class="flex min-h-0 flex-1 flex-col items-start gap-2 px-3 py-4">
      <div class="flex items-center gap-2">
        <Show when={props.critical}>
          <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-icon-critical-base" />
        </Show>
        <span class="text-compact font-medium text-text-base">{props.failure.message}</span>
      </div>
      <Show when={props.failure.detail}>
        <p class="line-clamp-3 text-sm leading-snug text-text-weak" title={props.failure.detail}>
          {props.failure.detail}
        </p>
      </Show>
      <Show when={props.failure.action}>
        {(action) => (
          <button
            type="button"
            class="mt-0.5 rounded-md px-2 py-1 text-compact text-text-base outline-none transition-colors duration-100 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover"
            onClick={() => action().run()}
          >
            {action().label}
          </button>
        )}
      </Show>
    </div>
  )
}
