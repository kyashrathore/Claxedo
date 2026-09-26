import { Show } from "solid-js"
import { ClaxedoIcon as Icon, FileIcon, getDirectory, getFilename } from "@/ui"
import type { AtOption } from "./slash-popover"

export function AtOptionRow(props: {
  item: AtOption
  id: string
  active: boolean
  onSelect: () => void
  onHover: () => void
}) {
  return (
    <button
      role="option"
      id={props.id}
      aria-selected={props.active}
      class={atOptionClass(props.item)}
      classList={{ "bg-surface-raised-base-hover": props.active }}
      onClick={() => props.onSelect()}
      onMouseEnter={() => props.onHover()}
    >
      <AtOptionContent item={props.item} />
    </button>
  )
}

function atOptionClass(item: AtOption) {
  if (item.type === "document") return "w-full flex items-center justify-between gap-3 rounded-md px-2 py-1"
  return "w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
}

function AtOptionContent(props: { item: AtOption }) {
  if (props.item.type === "document") return <DocumentOption item={props.item} />
  if (props.item.type === "agent") return <AgentOption item={props.item} />
  return <FileOption item={props.item} />
}

function DocumentOption(props: { item: Extract<AtOption, { type: "document" }> }) {
  return (
    <>
      <span class="flex items-center gap-2 min-w-0">
        <Icon name="prompt" size="small" class="text-icon-base shrink-0" />
        <span class="text-14-regular text-text-strong truncate">{props.item.display}</span>
      </span>
      <span class="text-11-regular text-text-weak shrink-0">{props.item.status}</span>
    </>
  )
}

function AgentOption(props: { item: Extract<AtOption, { type: "agent" }> }) {
  return (
    <>
      <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
      <span class="text-14-regular text-text-strong whitespace-nowrap">@{props.item.display}</span>
    </>
  )
}

function FileOption(props: { item: Extract<AtOption, { type: "file" }> }) {
  const isDirectory = props.item.path.endsWith("/")
  const directory = isDirectory ? props.item.path : getDirectory(props.item.path)
  const filename = isDirectory ? "" : getFilename(props.item.path)

  return (
    <>
      <FileIcon node={{ path: props.item.path, type: "file" }} class="shrink-0 size-4" />
      <div class="flex items-center text-14-regular min-w-0">
        <span class="text-text-weak whitespace-nowrap truncate min-w-0">{directory}</span>
        <Show when={!isDirectory}>
          <span class="text-text-strong whitespace-nowrap">{filename}</span>
        </Show>
      </div>
    </>
  )
}
