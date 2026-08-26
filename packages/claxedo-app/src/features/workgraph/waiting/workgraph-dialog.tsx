import { Dialog as DialogRoot } from "@kobalte/core/dialog"
import { Dialog as DialogShell } from "@opencode-ai/ui/dialog"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import type { AsyncState } from "@/lib/async-state"
import { Match, Show, Switch } from "solid-js"
import type { JSX } from "@solidjs/web"

/**
 * Focused, modal WorkGraph dialog. Modal Kobalte content brings focus trapping,
 * focus restoration to the trigger, Escape-to-close and a backdrop — the
 * accessibility model required for the item/settings dialogs. Rendered over the
 * same WorkGraph screen; opening never navigates.
 */
export function WorkGraphDialog(props: {
  open: boolean
  onClose: () => void
  title: JSX.Element
  description?: JSX.Element
  size?: "normal" | "large" | "x-large"
  fit?: boolean
  /** Keeps dialog chrome fixed while the feature body owns its scroll region. */
  scrollBody?: boolean
  footer?: JSX.Element
  children: JSX.Element
}) {
  return (
    <DialogRoot
      modal
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <DialogRoot.Portal>
        <div class="workgraph-dialog-scope">
          <DialogRoot.Overlay data-component="dialog-overlay" class="ui-dialog-overlay" />
          <DialogShell
            fit={props.fit}
            size={props.size ?? "normal"}
            title={props.title}
            description={props.description}
            onEscapeKeyDown={props.onClose}
            action={<IconButton variant="ghost" size="small" icon="close" aria-label="Close" onClick={props.onClose} />}
          >
            <div class={["workgraph-item-dialog", { "is-scroll-shell": !!props.scrollBody }]}>
              <div class="workgraph-item-dialog-body" data-scrollable={props.scrollBody ? "true" : undefined}>
                {props.children}
              </div>
              <Show when={props.footer}>
                <div class="workgraph-item-dialog-footer">{props.footer}</div>
              </Show>
            </div>
          </DialogShell>
        </div>
      </DialogRoot.Portal>
    </DialogRoot>
  )
}

/**
 * Renders explicit loading / error / empty / ready states for a detail
 * resource. Never fabricates content — on error it shows the real message with
 * a retry, never a snapshot-derived guess.
 */
export function DetailState<T>(props: {
  resource: AsyncState<T>
  retry?: () => void
  emptyWhen?: (value: T) => boolean
  emptyLabel?: string
  /** Layout-shaped placeholder rendered while loading instead of the bare text. */
  skeleton?: JSX.Element
  children: (value: T) => JSX.Element
}) {
  return (
    <Switch>
      <Match when={props.resource.loading() && props.resource.data() === undefined}>
        <Show
          when={props.skeleton}
          fallback={
            <div class="workgraph-detail-status" role="status" aria-live="polite">
              Loading…
            </div>
          }
        >
          {(skeleton) => <>{skeleton()}</>}
        </Show>
      </Match>
      <Match when={props.resource.error()}>
        <div class="workgraph-detail-status is-error" role="alert">
          <span>{errorMessage(props.resource.error())}</span>
          <Show when={props.retry}>
            <button type="button" class="workgraph-detail-retry" onClick={props.retry}>
              Retry
            </button>
          </Show>
        </div>
      </Match>
      <Match when={props.resource.data()}>
        {(value) => (
          <Show
            when={!props.emptyWhen?.(value())}
            fallback={<div class="workgraph-detail-status">{props.emptyLabel ?? "Nothing to show."}</div>}
          >
            {props.children(value())}
          </Show>
        )}
      </Match>
    </Switch>
  )
}

export function DialogSection(props: { title: string; children: JSX.Element; trailing?: JSX.Element }) {
  return (
    <section class="workgraph-dsection">
      <div class="workgraph-dsection-head">
        <h3 class="workgraph-dsection-title text-text-base">{props.title}</h3>
        {props.trailing}
      </div>
      {props.children}
    </section>
  )
}

export function DialogField(props: { label: string; children: JSX.Element; mono?: boolean }) {
  return (
    <div class="workgraph-dfield">
      <span class="workgraph-dfield-label text-text-base">{props.label}</span>
      <span class={["workgraph-dfield-value text-text-base", { "font-mono": !!props.mono }]}>{props.children}</span>
    </div>
  )
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return "This could not be loaded."
}
