import { Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon, Tag } from "@/ui"
import { surfaceIcon } from "../icon-names"
import { codeFence, webUrl } from "../text-format"
import type { SurfaceNodeProps } from "../model"
import { useSurfaceMarkdown, useSurfaceRichText } from "./surface-rich-text"
import { useSurfaceReader } from "./surface-runtime"

type TextVariant = NonNullable<SurfaceNodeProps<"Text">["def"]["variant"]>

const TEXT_TAGS: Record<TextVariant, string> = { h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", caption: "span", body: "span" }

const TEXT_CLASSES: Record<TextVariant, string> = {
  h1: "text-20-medium",
  h2: "text-18-medium",
  h3: "text-16-medium",
  h4: "text-14-medium",
  h5: "text-13-medium",
  caption: "text-12-regular text-text-weak",
  body: "text-14-regular",
}

export function TextView(props: SurfaceNodeProps<"Text">) {
  const read = useSurfaceReader()
  const variant = () => props.def.variant ?? "body"
  return (
    <Dynamic component={TEXT_TAGS[variant()]} data-slot="surface-text" class={TEXT_CLASSES[variant()]}>
      {read.text(props.def.text, props.scope)}
    </Dynamic>
  )
}

export function MarkdownView(props: SurfaceNodeProps<"Markdown">) {
  const read = useSurfaceReader()
  const Markdown = useSurfaceMarkdown()
  return <Markdown text={read.text(props.def.text, props.scope)} />
}

export function CodeView(props: SurfaceNodeProps<"Code">) {
  const read = useSurfaceReader()
  const Markdown = useSurfaceMarkdown()
  return <Markdown text={codeFence(read.text(props.def.text, props.scope), props.def.language)} />
}

export function IconView(props: SurfaceNodeProps<"Icon">) {
  const read = useSurfaceReader()
  return <Show when={surfaceIcon(read.value(props.def.name, props.scope))}>{(name) => <Icon name={name()} size="small" />}</Show>
}

export function BadgeView(props: SurfaceNodeProps<"Badge">) {
  const read = useSurfaceReader()
  return <Tag variant={props.def.variant ?? "neutral"}>{read.text(props.def.text, props.scope)}</Tag>
}

export function LinkView(props: SurfaceNodeProps<"Link">) {
  const read = useSurfaceReader()
  const richText = useSurfaceRichText()
  const label = () => read.text(props.def.text, props.scope)
  return (
    <Show when={webUrl(read.text(props.def.url, props.scope))} fallback={<span>{label()}</span>}>
      {(href) => (
        <a data-slot="surface-link" href={href()} target="_blank" rel="noopener noreferrer" onClick={(event) => richText?.onLinkClick(event)}>
          {label()}
        </a>
      )}
    </Show>
  )
}
