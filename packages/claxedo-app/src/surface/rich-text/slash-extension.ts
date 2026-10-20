import { Extension } from "@tiptap/core"
import { PluginKey } from "@tiptap/pm/state"
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion"
import { matchingBlockCommands, type BlockCommand, type BlockCommandId } from "./slash-commands"

export type SlashMenuState = {
  readonly items: readonly BlockCommand[]
  readonly anchor: DOMRect | null
  readonly pick: (command: BlockCommand) => void
}

export type SlashMenuHost = {
  readonly show: (state: SlashMenuState) => void
  readonly key: (event: KeyboardEvent) => boolean
  readonly hide: () => void
}

type Picked = { readonly command: BlockCommand }

function menuState(props: SuggestionProps<BlockCommand, Picked>): SlashMenuState {
  return { items: props.items, anchor: props.clientRect?.() ?? null, pick: (command) => props.command({ command }) }
}

export function slashExtension(host: SlashMenuHost, label: (id: BlockCommandId) => string) {
  return Extension.create({
    name: "surfaceSlashCommands",
    addProseMirrorPlugins() {
      return [
        Suggestion<BlockCommand, Picked>({
          editor: this.editor,
          pluginKey: new PluginKey("surfaceSlashCommands"),
          char: "/",
          allowedPrefixes: null,
          startOfLine: false,
          items: ({ query }) => [...matchingBlockCommands(query, label)],
          command: ({ editor, range, props }) => props.command.run(editor, range),
          render: () => ({
            onStart: (props) => host.show(menuState(props)),
            onUpdate: (props) => host.show(menuState(props)),
            onKeyDown: (props: SuggestionKeyDownProps) => host.key(props.event),
            onExit: () => host.hide(),
          }),
        }),
      ]
    },
  })
}
