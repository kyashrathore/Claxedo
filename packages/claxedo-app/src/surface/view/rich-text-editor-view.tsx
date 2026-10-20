import { createEffect, createSignal, Match, on, onCleanup, onMount, Switch } from "solid-js"
import { useTranslator } from "@/i18n"
import { machine } from "@/lib/machine"
import { Button } from "@/ui"
import { boundText, createBoundValue } from "../binding"
import { surfaceDictionary } from "../i18n"
import { createInputDebounce } from "../input-debounce"
import type { SurfaceNodeProps } from "../model"
import { loadRichTextModule, type RichTextEditorHandle, type RichTextModule } from "../rich-text/module"
import { richTextModeTransition, type RichTextMode, type RichTextModeEvent } from "../rich-text-mode"
import { isSubmitKey } from "../submit-key"
import { RichTextHost } from "./rich-text-host"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

type SourceMode = Extract<RichTextMode, { kind: "source" }>

function sourceMode(mode: RichTextMode): SourceMode | undefined {
  return mode.kind === "source" ? mode : undefined
}

function SourceNotice(props: { readonly mode: SourceMode; readonly onRecheck: () => void }) {
  const t = useTranslator(surfaceDictionary)
  return (
    <div data-slot="surface-editor-source-notice" role="status">
      <span data-slot="surface-editor-source-title">{t("surface.editor.sourceTitle")}</span>
      <span>{t(props.mode.reason === "failed" ? "surface.editor.sourceFailed" : props.mode.rechecked ? "surface.editor.stillSource" : "surface.editor.sourceReason")}</span>
      {props.mode.reason === "markdown" ? (
        <Button variant="ghost" size="small" onClick={() => props.onRecheck()}>
          {t("surface.editor.tryRich")}
        </Button>
      ) : undefined}
    </div>
  )
}

export function RichTextEditorView(props: SurfaceNodeProps<"RichTextEditor">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const t = useTranslator(surfaceDictionary)
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundText)
  const mode = machine<RichTextMode, RichTextModeEvent>({ kind: "loading" }, richTextModeTransition)
  const [module, setModule] = createSignal<RichTextModule>()
  let editor: RichTextEditorHandle | undefined
  let written = field.value()
  const fire = (action: typeof props.def.change, value: string) => runtime.fire(action, props.def.id, props.scope, { value })
  const changes = createInputDebounce<string>((markdown) => {
    written = markdown
    field.set(markdown)
    if (runtime.source.kind !== "agent") fire(props.def.change, markdown)
  })
  onCleanup(changes.cancel)
  const fits = (markdown: string) => module()?.markdownFits(markdown) ?? false
  onMount(() => {
    loadRichTextModule()
      .then((loaded) => {
        setModule(() => loaded)
        mode.send({ type: "loaded", fits: loaded.markdownFits(field.value()) })
      })
      .catch((error: unknown) => {
        console.warn("The rich text editor did not load", { componentId: props.def.id, error })
        mode.send({ type: "loadFailed" })
      })
  })
  createEffect(
    on(field.value, (value) => {
      if (value === written) return
      written = value
      changes.cancel()
      if (module()) mode.send({ type: "valueReplaced", fits: fits(value) })
      editor?.setMarkdown(value)
    }),
  )
  const submitOnKey = (event: KeyboardEvent) => {
    if (!isSubmitKey(event, "text")) return
    event.preventDefault()
    changes.flush()
    fire(props.def.submit, field.value())
  }
  const sourceInput = (value: string) => {
    written = value
    field.set(value)
    changes.schedule(value)
  }
  const label = () => read.text(props.def.label, props.scope)
  const placeholder = () => read.text(props.def.placeholder, props.scope)
  let root: HTMLDivElement | undefined
  onMount(() => {
    root?.addEventListener("keydown", submitOnKey, true)
    onCleanup(() => root?.removeEventListener("keydown", submitOnKey, true))
  })
  return (
    <div ref={root} data-slot="surface-editor" data-mode={mode.state().kind}>
      <Switch>
        <Match when={mode.state().kind === "loading"}>
          <div data-slot="surface-editor-loading" aria-label={t("surface.editor.loading")} aria-busy="true" />
        </Match>
        <Match when={mode.state().kind === "rich" ? module() : undefined}>
          {(loaded) => (
            <RichTextHost
              module={loaded()}
              markdown={field.value()}
              label={label()}
              placeholder={placeholder()}
              opened={(handle) => (editor = handle)}
              onChange={changes.schedule}
              onBlur={changes.flush}
            />
          )}
        </Match>
        <Match when={sourceMode(mode.state())}>
          {(source) => (
            <>
              <SourceNotice mode={source()} onRecheck={() => mode.send({ type: "rechecked", fits: fits(field.value()) })} />
              <textarea
                data-slot="surface-editor-source"
                aria-label={label()}
                placeholder={placeholder()}
                value={field.value()}
                onInput={(event) => sourceInput(event.currentTarget.value)}
                onBlur={changes.flush}
              />
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
