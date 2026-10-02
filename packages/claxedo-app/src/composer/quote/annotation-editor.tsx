import { createEffect, createSignal, on, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { QuoteContextItem } from "../model"
import { useComposerStore, type ComposerKey } from "../store"
import { useComposerText } from "../text"
import { createAnchoredPosition } from "./anchored-position"
import { findQuoteRange } from "./find-quote"
import { highlightRange } from "./highlight"
import { QuoteBox } from "./quote-box"
import { clippingArea, type Box } from "./selected-quote"
import { quoteSurfaceKey, useQuoteSurfaces } from "./surfaces"

function NumberBadge(props: { readonly number: number; readonly anchor: Box }): JSX.Element {
  return (
    <Portal>
      <span
        aria-hidden="true"
        class="pointer-events-none fixed z-50 flex size-5 items-center justify-center rounded-full bg-v2-background-bg-accent text-11-medium text-v2-text-text-contrast"
        style={{ left: `${props.anchor.right - 10}px`, top: `${props.anchor.top - 10}px` }}
      >
        {props.number}
      </span>
    </Portal>
  )
}

function createQuotedRange(root: Accessor<HTMLElement | undefined>, quote: Accessor<string>) {
  const [range, setRange] = createSignal<Range>()
  createEffect(
    on([root, quote], ([surface, text]) => {
      const found = surface ? findQuoteRange(surface, text) : undefined
      setRange(found)
      found?.startContainer.parentElement?.scrollIntoView({ block: "center" })
    }),
  )
  return range
}

export function AnnotationEditor(props: {
  readonly composerKey: ComposerKey
  readonly item: QuoteContextItem
  readonly number: number
  readonly chip: Accessor<HTMLElement | undefined>
  readonly onClose: () => void
}): JSX.Element {
  const store = useComposerStore()
  const surfaces = useQuoteSurfaces()
  const t = useComposerText()
  const [draft, setDraft] = createSignal(props.item.comment)
  const root = () => surfaces.root(quoteSurfaceKey(props.composerKey, props.item.source))
  const range = createQuotedRange(root, () => props.item.quote)
  const anchored = createAnchoredPosition({
    anchor: () => range()?.getBoundingClientRect() ?? props.chip()?.getBoundingClientRect(),
    area: () => {
      const surface = root()
      return range() && surface ? clippingArea(surface)?.getBoundingClientRect() : undefined
    },
  })
  createEffect(on([range, props.chip], () => {
    const frame = requestAnimationFrame(anchored.place)
    onCleanup(() => cancelAnimationFrame(frame))
  }))
  highlightRange("composer-quote-edit", range)
  let box: HTMLElement | undefined
  makeEventListener(document, "pointerdown", (event) => {
    if (!(event.target instanceof Node && box?.contains(event.target))) props.onClose()
  }, { capture: true })
  const save = (comment: string) => {
    const context = store.draft(props.composerKey).context
    store.setContext(props.composerKey, context.map((item) => (item.key === props.item.key ? { ...props.item, comment } : item)))
    props.onClose()
  }
  return (
    <>
      <Show when={anchored.position()}>
        {(position) => (
          <QuoteBox
            position={position()}
            ref={(element) => (box = element)}
            value={draft()}
            autofocus={true}
            submitLabel={t("prompt.annotations.save")}
            onInput={setDraft}
            onCancel={props.onClose}
            onSubmit={save}
          />
        )}
      </Show>
      <Show when={range() && anchored.anchor()}>{(anchor) => <NumberBadge number={props.number} anchor={anchor()} />}</Show>
    </>
  )
}
