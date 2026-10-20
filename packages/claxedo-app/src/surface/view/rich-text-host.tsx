import { onCleanup, onMount } from "solid-js"
import { useTranslator } from "@/i18n"
import { surfaceDictionary } from "../i18n"
import type { RichTextEditorHandle, RichTextModule } from "../rich-text/module"
import { createSlashMenu, BLOCK_COMMAND_KEYS, SlashMenuList } from "./slash-menu"

export type RichTextHostProps = {
  readonly module: RichTextModule
  readonly markdown: string
  readonly label: string
  readonly placeholder: string
  readonly opened: (handle: RichTextEditorHandle | undefined) => void
  readonly onChange: (markdown: string) => void
  readonly onBlur: () => void
}

export function RichTextHost(props: RichTextHostProps) {
  const t = useTranslator(surfaceDictionary)
  const menu = createSlashMenu()
  let element: HTMLDivElement | undefined
  let frame: HTMLDivElement | undefined
  onMount(() => {
    if (!element) return
    const handle = props.module.createRichTextEditor({
      element,
      markdown: props.markdown,
      label: props.label,
      placeholder: props.placeholder,
      slash: menu.host,
      commandLabel: (id) => t(BLOCK_COMMAND_KEYS[id]),
      onChange: props.onChange,
      onBlur: props.onBlur,
    })
    props.opened(handle)
    onCleanup(() => {
      props.opened(undefined)
      handle.destroy()
    })
  })
  return (
    <div ref={frame} data-slot="surface-editor-frame">
      <div ref={element} data-slot="surface-editor-rich" />
      <SlashMenuList menu={menu} frame={() => frame} />
    </div>
  )
}
