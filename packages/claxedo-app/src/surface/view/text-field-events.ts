import { onCleanup } from "solid-js"
import type { SurfaceActionDefinition } from "@claxedo/plugin-api/surface"
import type { BoundValue } from "../binding"
import { createInputDebounce } from "../input-debounce"
import type { DataPath } from "../model"
import { isSubmitKey, type SubmitKeys } from "../submit-key"
import type { SurfaceRuntime } from "./surface-runtime"

export type TextFieldEventSource = {
  readonly id: string
  readonly scope: DataPath
  readonly submit: SurfaceActionDefinition | undefined
  readonly change: SurfaceActionDefinition | undefined
  readonly keys: SubmitKeys
}

export type TextFieldEvents = {
  readonly input: (value: string) => void
  readonly keyDown: (event: KeyboardEvent) => void
  readonly blur: () => void
  readonly submit: () => void
}

export function createTextFieldEvents(runtime: SurfaceRuntime, field: BoundValue<string>, source: () => TextFieldEventSource): TextFieldEvents {
  const changes = createInputDebounce<string>((value) => {
    const current = source()
    if (runtime.source.kind !== "agent") runtime.fire(current.change, current.id, current.scope, { value })
  })
  onCleanup(changes.cancel)
  const submit = () => {
    changes.flush()
    const current = source()
    runtime.fire(current.submit, current.id, current.scope, { value: field.value() })
  }
  return {
    input: (value) => {
      field.set(value)
      if (source().change !== undefined) changes.schedule(value)
    },
    keyDown: (event) => {
      if (source().submit === undefined || !isSubmitKey(event, source().keys)) return
      event.preventDefault()
      submit()
    },
    blur: changes.flush,
    submit,
  }
}
