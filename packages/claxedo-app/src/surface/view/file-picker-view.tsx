import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js"
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

function listenForFiles(scope: HTMLElement, pastes: boolean, take: (files: readonly File[]) => boolean, dragging: (over: boolean) => void): () => void {
  const paste = (event: ClipboardEvent) => {
    if (take(droppedFiles(event.clipboardData))) event.preventDefault()
  }
  const over = (event: DragEvent) => {
    if (event.defaultPrevented || !hasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragging(true)
  }
  const leave = (event: DragEvent) => {
    if (!(event.relatedTarget instanceof Node) || !scope.contains(event.relatedTarget)) dragging(false)
  }
  const drop = (event: DragEvent) => {
    dragging(false)
    if (event.defaultPrevented || !hasFiles(event.dataTransfer)) return
    if (take(droppedFiles(event.dataTransfer))) event.preventDefault()
  }
  if (pastes) scope.addEventListener("paste", paste)
  scope.addEventListener("dragover", over)
  scope.addEventListener("dragleave", leave)
  scope.addEventListener("drop", drop)
  return () => {
    scope.removeEventListener("paste", paste)
    scope.removeEventListener("dragover", over)
    scope.removeEventListener("dragleave", leave)
    scope.removeEventListener("drop", drop)
  }
}

export function FilePickerView(props: SurfaceNodeProps<"FilePicker">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const t = useTranslator(surfaceDictionary)
  const [reading, setReading] = createSignal(0)
  const [dragOver, setDragOver] = createSignal(false)
  const labelId = createUniqueId()
  const inert = () => runtime.source.kind === "agent" || runtime.actionsDisabled()
  const label = () => read.text(props.def.label, props.scope)
  const button = () => props.def.variant === "button"
  const take = (files: readonly File[]) => {
    if (inert() || files.length === 0) return false
    setReading((count) => count + 1)
    const rules = { accept: props.def.accept, maxBytes: props.def.maxBytes, maxFiles: props.def.maxFiles ?? 1, fitImages: props.def.fitImages === true }
    readPickedFiles(files, rules)
      .then((pick) => runtime.fire(props.def.pick, props.def.id, props.scope, filePickFields(pick)))
      .catch((error: unknown) => console.warn("Reading picked files failed", { componentId: props.def.id, error }))
      .finally(() => setReading((count) => count - 1))
    return true
  }
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  onMount(() => {
    if (!root) return
    const pasted = pasteTarget<HTMLElement>(props.def.paste, root)
    onCleanup(listenForFiles(pasted ?? root, pasted !== undefined, take, setDragOver))
  })
  return (
    <div
      ref={root}
      data-slot="surface-file-picker"
      data-variant={button() ? "button" : "dropzone"}
      data-drop-target={dragOver() ? "true" : "false"}
      role="group"
      aria-labelledby={labelId}
      tabIndex={props.def.paste === "self" && !inert() ? 0 : undefined}
    >
      <span id={labelId} data-slot="surface-input-label" classList={{ "sr-only": button() }}>
        {label()}
      </span>
      <Show
        when={button()}
        fallback={
          <div data-slot="surface-file-drop">
            <Button variant="neutral" disabled={inert()} onClick={() => input?.click()}>
              <SurfaceIcon name="upload" size="small" />
              {t((props.def.maxFiles ?? 1) > 1 ? "surface.file.chooseMany" : "surface.file.chooseOne")}
            </Button>
            <span data-slot="surface-file-hint" aria-live="polite">
              {reading() > 0 ? t("surface.file.reading") : t(props.def.paste ? "surface.file.dropOrPaste" : "surface.file.drop")}
            </span>
          </div>
        }
      >
        <Button data-slot="surface-button" data-icon-only="true" variant="ghost" disabled={inert()} title={label()} aria-label={label()} aria-busy={reading() > 0} onClick={() => input?.click()}>
          <SurfaceIcon name="photo" size="small" />
        </Button>
      </Show>
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
