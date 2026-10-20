import { createUniqueId, Show } from "solid-js"
import type { SurfaceNodeProps } from "../model"
import { ComboboxChips, ComboboxList } from "./combobox-list"
import { createComboboxState, type ComboboxState } from "./combobox-state"
import { useSurfaceReader } from "./surface-runtime"

function comboboxKey(event: KeyboardEvent, state: ComboboxState) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault()
    return state.step(event.key === "ArrowDown" ? 1 : -1)
  }
  if (event.key === "Escape" && state.open()) {
    event.preventDefault()
    return state.close()
  }
  const choice = state.shown()[state.active()]
  if (event.key === "Enter" && state.open() && choice) {
    event.preventDefault()
    state.pick(choice)
  }
}

export function ComboboxView(props: SurfaceNodeProps<"Combobox">) {
  const read = useSurfaceReader()
  const state = createComboboxState(props)
  const inputId = createUniqueId()
  const listId = createUniqueId()
  const optionId = (index: number) => `${listId}-${index}`
  const label = () => (props.def.label === undefined ? undefined : read.text(props.def.label, props.scope))
  return (
    <div data-slot="surface-combobox">
      <Show when={label()}>
        {(text) => (
          <label for={inputId} data-slot="surface-input-label">
            {text()}
          </label>
        )}
      </Show>
      <Show when={state.multiple()}>
        <ComboboxChips chosen={state.chosenChoices()} onRemove={state.pick} />
      </Show>
      <input
        id={inputId}
        data-slot="surface-combobox-input"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded={state.open()}
        aria-controls={listId}
        aria-activedescendant={state.active() >= 0 ? optionId(state.active()) : undefined}
        placeholder={props.def.placeholder === undefined ? undefined : read.text(props.def.placeholder, props.scope)}
        value={state.inputText()}
        onInput={(event) => state.typed(event.currentTarget.value)}
        onFocus={() => state.show()}
        onBlur={() => state.close()}
        onKeyDown={(event) => comboboxKey(event, state)}
      />
      <Show when={state.open()}>
        <ComboboxList
          id={listId}
          choices={state.shown()}
          chosen={state.chosen()}
          multiple={state.multiple()}
          active={state.active()}
          searching={state.searching()}
          emptyText={props.def.emptyText === undefined ? undefined : read.text(props.def.emptyText, props.scope)}
          optionId={optionId}
          onChoose={state.pick}
        />
      </Show>
    </div>
  )
}
