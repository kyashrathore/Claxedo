import { createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import { filePickFields, pasteTarget, readPickedFiles } from "../file-read"
import { surfaceDictionary } from "../i18n"
import type { SurfaceNodeProps } from "../model"
import { SurfaceIcon } from "./surface-icon"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

function droppedFiles(transfer: DataTransfer | null): File[] {
  return transfer ? [...transfer.files] : []
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return transfer?.types.includes("Files") === true
}

export function FilePickerView(props: SurfaceNodeProps<"FilePicker">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const t = useTranslator(surfaceDictionary)
  const [reading, setReading] = createSignal(0)
  const [dragOver, setDragOver] = createSignal(false)
  const labelId = createUniqueId()
  const inert = () => runtime.source.kind === "agent" || runtime.actionsDisabled()
  const take = (files: readonly File[]) => {
    if (inert() || files.length === 0) return
    setReading((count) => count + 1)
    const rules = { accept: props.def.accept, maxBytes: props.def.maxBytes, maxFiles: props.def.maxFiles ?? 1, fitImages: props.def.fitImages === true }
    readPickedFiles(files, rules)
      .then((pick) => runtime.fire(props.def.pick, props.def.id, props.scope, filePickFields(pick)))
      .catch((error: unknown) => console.warn("Reading picked files failed", { componentId: props.def.id, error }))
      .finally(() => setReading((count) => count - 1))
  }
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  onMount(() => {
    const scope = root ? pasteTarget<HTMLElement>(props.def.paste, root) : undefined
    if (!scope) return
    const paste = (event: ClipboardEvent) => {
      const files = droppedFiles(event.clipboardData)
      if (files.length === 0 || inert()) return
      event.preventDefault()
      take(files)
    }
    scope.addEventListener("paste", paste)
    onCleanup(() => scope.removeEventListener("paste", paste))
  })
  return (
    <div
      ref={root}
      data-slot="surface-file-picker"
      data-drop-target={dragOver() ? "true" : "false"}
      role="group"
      aria-labelledby={labelId}
      tabIndex={props.def.paste === "self" && !inert() ? 0 : undefined}
      onDragOver={(event) => {
        if (inert() || !hasFiles(event.dataTransfer)) return
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        setDragOver(false)
        if (inert() || !hasFiles(event.dataTransfer)) return
        event.preventDefault()
        take(droppedFiles(event.dataTransfer))
      }}
    >
      <span id={labelId} data-slot="surface-input-label">
        {read.text(props.def.label, props.scope)}
      </span>
      <div data-slot="surface-file-drop">
        <Button variant="neutral" disabled={inert()} onClick={() => input?.click()}>
          <SurfaceIcon name="upload" size="small" />
          {t((props.def.maxFiles ?? 1) > 1 ? "surface.file.chooseMany" : "surface.file.chooseOne")}
        </Button>
        <span data-slot="surface-file-hint" aria-live="polite">
          {reading() > 0 ? t("surface.file.reading") : t(props.def.paste ? "surface.file.dropOrPaste" : "surface.file.drop")}
        </span>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={props.def.accept.join(",")}
        multiple={(props.def.maxFiles ?? 1) > 1}
        disabled={inert()}
        aria-labelledby={labelId}
        onChange={(event) => {
          take([...(event.currentTarget.files ?? [])])
          event.currentTarget.value = ""
        }}
      />
    </div>
  )
}
