import { createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { boundText, createBoundValue } from "../binding"
import { boundChoices, chosenValues, choose, matchingChoices, steppedActive, type ComboChoice } from "../combobox-options"
import { isBinding, pathsOverlap, resolvePath } from "../data-path"
import type { DataPath, SurfaceNodeProps } from "../model"
import { createSearchDebounce } from "../search-debounce"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

function createChoices(props: SurfaceNodeProps<"Combobox">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const optionsPath = createMemo((): DataPath | undefined => (isBinding(props.def.options) ? resolvePath(props.def.options.path, props.scope) : undefined))
  const choices = createMemo((): readonly ComboChoice[] => {
    const options = props.def.options
    if (isBinding(options)) return boundChoices(runtime.state.data.read(resolvePath(options.path, props.scope)))
    return options.map((option) => ({
      value: option.value,
      label: read.text(option.label, props.scope),
      ...(option.description === undefined ? {} : { description: read.text(option.description, props.scope) }),
    }))
  })
  return { optionsPath, choices }
}

function createSearch(props: SurfaceNodeProps<"Combobox">, optionsPath: () => DataPath | undefined) {
  const runtime = useSurfaceRuntime()
  const [searching, setSearching] = createSignal(false)
  const searches = () => props.def.search !== undefined && runtime.source.kind !== "agent"
  onCleanup(
    runtime.state.watchPatches((path) => {
      const at = untrack(optionsPath)
      if (at && pathsOverlap(path, at)) setSearching(false)
    }),
  )
  const debounce = createSearchDebounce((query) => {
    if (!searches() || runtime.actionsDisabled()) return
    if (optionsPath()) setSearching(true)
    runtime.fire(props.def.search, props.def.id, props.scope, { query })
  })
  onCleanup(debounce.cancel)
  return { searching, searches, schedule: debounce.schedule }
}

function createOptionMenu() {
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(-1)
  const [editing, setEditing] = createSignal(false)
  return {
    open,
    active,
    editing,
    typing: () => {
      setEditing(true)
      setOpen(true)
      setActive(-1)
    },
    show: () => setOpen(true),
    close: () => {
      setOpen(false)
      setActive(-1)
      setEditing(false)
    },
    step: (step: 1 | -1, count: number) => {
      setOpen(true)
      setActive((current) => steppedActive(current, step, count))
    },
  }
}

function createChosen(props: SurfaceNodeProps<"Combobox">, choices: () => readonly ComboChoice[]) {
  const runtime = useSurfaceRuntime()
  const multiple = () => props.def.multiple === true
  const valuePath = () => resolvePath(props.def.value.path, props.scope)
  const chosen = () => chosenValues(runtime.state.data.read(valuePath()), multiple())
  const labelOf = (value: string) => choices().find((choice) => choice.value === value) ?? { value, label: value }
  return {
    multiple,
    chosen,
    chosenChoices: () => chosen().map(labelOf),
    chosenLabel: () => chosen().map((value) => labelOf(value).label)[0],
    write: (choice: ComboChoice) => {
      const next = choose(chosen(), choice.value, multiple())
      runtime.state.data.write(valuePath(), multiple() ? next : choice.value)
      runtime.fire(props.def.change, props.def.id, props.scope, { value: multiple() ? next : choice.value })
    },
  }
}

export function createComboboxState(props: SurfaceNodeProps<"Combobox">) {
  const runtime = useSurfaceRuntime()
  const query = createBoundValue(() => props.def.query, () => props.scope, runtime.state.data, boundText)
  const { optionsPath, choices } = createChoices(props)
  const search = createSearch(props, optionsPath)
  const menu = createOptionMenu()
  const value = createChosen(props, choices)
  const shown = createMemo(() => matchingChoices(choices(), query.value(), !search.searches() && menu.editing()))
  const pick = (choice: ComboChoice) => {
    value.write(choice)
    if (!value.multiple()) menu.close()
  }
  return {
    ...value,
    shown,
    open: menu.open,
    active: menu.active,
    searching: search.searching,
    inputText: () => (menu.editing() || value.multiple() ? query.value() : (value.chosenLabel() ?? query.value())),
    pick,
    typed: (text: string) => {
      query.set(text)
      menu.typing()
      search.schedule(text)
    },
    show: menu.show,
    close: menu.close,
    step: (step: 1 | -1) => menu.step(step, shown().length),
  }
}

export type ComboboxState = ReturnType<typeof createComboboxState>
