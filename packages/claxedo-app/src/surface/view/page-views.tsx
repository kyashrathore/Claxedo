import { createUniqueId, Show } from "solid-js"
import { surfaceIconName } from "../icon-names"
import type { SurfaceNodeProps } from "../model"
import { SurfaceGroup } from "./surface-children"
import { SurfaceIcon } from "./surface-icon"
import { SurfaceNode } from "./surface-node"
import { useSurfaceReader } from "./surface-runtime"

export function HeaderView(props: SurfaceNodeProps<"Header">) {
  const read = useSurfaceReader()
  return (
    <header data-slot="surface-header">
      <Show when={surfaceIconName(props.def.icon)}>
        {(name) => (
          <span data-slot="surface-header-icon">
            <SurfaceIcon name={name()} size="normal" />
          </span>
        )}
      </Show>
      <div data-slot="surface-header-title-row">
        <h2 data-slot="surface-header-title">{read.text(props.def.title, props.scope)}</h2>
        <SurfaceGroup ids={props.def.badges} scope={props.scope} slot="surface-badges" />
      </div>
      <Show when={read.text(props.def.subtitle, props.scope)}>
        {(text) => (
          <p data-slot="surface-header-subtitle" title={text()}>
            {text()}
          </p>
        )}
      </Show>
      <SurfaceGroup ids={props.def.actions} scope={props.scope} slot="surface-actions" />
    </header>
  )
}

export function SectionView(props: SurfaceNodeProps<"Section">) {
  const read = useSurfaceReader()
  const titleId = createUniqueId()
  const title = () => read.text(props.def.title, props.scope)
  const description = () => read.text(props.def.description, props.scope)
  const hasHead = () => title() !== "" || description() !== "" || (props.def.actions?.length ?? 0) > 0
  return (
    <section data-slot="surface-section" data-variant={props.def.variant ?? "card"} aria-labelledby={title() ? titleId : undefined}>
      <Show when={hasHead()}>
        <div data-slot="surface-section-head">
          <div data-slot="surface-section-heading">
            <Show when={title()}>{(text) => <h3 id={titleId} data-slot="surface-section-title">{text()}</h3>}</Show>
            <Show when={description()}>{(text) => <p data-slot="surface-section-description">{text()}</p>}</Show>
          </div>
          <SurfaceGroup ids={props.def.actions} scope={props.scope} slot="surface-actions" />
        </div>
      </Show>
      <SurfaceNode id={props.def.child} scope={props.scope} />
    </section>
  )
}

export function FooterView(props: SurfaceNodeProps<"Footer">) {
  return (
    <footer data-slot="surface-footer">
      <SurfaceGroup ids={props.def.start} scope={props.scope} slot="surface-footer-start" />
      <SurfaceGroup ids={props.def.end} scope={props.scope} slot="surface-footer-end" />
    </footer>
  )
}
