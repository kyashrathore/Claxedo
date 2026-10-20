import { createEffect, on } from "solid-js"
import { Dialog as Overlay } from "@kobalte/core/dialog"
import { useTranslator } from "@/i18n"
import { Icon } from "@/ui"
import { boundBoolean, createBoundValue } from "../binding"
import { createFocusReturn, DIALOG_FIRST_FIELD, ownsEscape } from "../dialog-focus"
import { surfaceDictionary } from "../i18n"
import type { SurfaceNodeProps } from "../model"
import { SurfaceNode } from "./surface-node"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"
import { SurfaceSourceMark } from "./surface-source-mark"

function focusFirstField(event: Event) {
  const content = event.currentTarget
  const field = content instanceof Element ? content.querySelector(DIALOG_FIRST_FIELD) : null
  if (!(field instanceof HTMLElement)) return
  event.preventDefault()
  field.focus({ preventScroll: true })
}

export function DialogView(props: SurfaceNodeProps<"Dialog">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const t = useTranslator(surfaceDictionary)
  const open = createBoundValue(() => props.def.open, () => props.scope, runtime.state.data, boundBoolean)
  const shown = () => open.value() && runtime.source.kind === "plugin"
  const focus = createFocusReturn()
  createEffect(on(shown, (now) => now && focus.remember(document.activeElement)))
  const close = () => {
    open.set(false)
    runtime.fire(props.def.close, props.def.id, props.scope, {})
  }
  return (
    <Overlay open={shown()} modal onOpenChange={(next) => !next && close()}>
      <Overlay.Portal>
        <Overlay.Overlay data-slot="surface-dialog-overlay" />
        <div data-slot="surface-dialog-position">
          <Overlay.Content
            data-component="surface"
            data-source={runtime.source.kind}
            data-placement="dialog"
            data-slot="surface-dialog"
            data-claxedo-compact-touch
            aria-label={read.text(props.def.title, props.scope)}
            onOpenAutoFocus={focusFirstField}
            onCloseAutoFocus={(event) => focus.restore() && event.preventDefault()}
            onEscapeKeyDown={(event) => ownsEscape(event.target) && event.preventDefault()}
          >
            <div data-slot="surface-dialog-head">
              <SurfaceSourceMark source={runtime.source} />
              <Overlay.CloseButton data-slot="surface-dialog-close" aria-label={t("surface.dialog.close")} title={t("surface.dialog.close")}>
                <Icon name="close" size="small" />
              </Overlay.CloseButton>
            </div>
            <SurfaceNode id={props.def.child} scope={props.scope} />
          </Overlay.Content>
        </div>
      </Overlay.Portal>
    </Overlay>
  )
}
