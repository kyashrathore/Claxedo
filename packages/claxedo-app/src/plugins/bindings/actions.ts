import type { CommandDefinition, MentionInsert, MentionProvider, PluginApi } from "@claxedo/plugin-api"
import type { CommandEntry, MentionEntry, MentionSource } from "@/shell"
import { commandContext, entryId, type BindingScope } from "./services"

type Actions = Pick<PluginApi, "commands" | "mentions">

function pluginCommandEntry(scope: BindingScope, command: CommandDefinition): CommandEntry {
  const context = () => commandContext(scope.services)
  const enabled = command.enabled?.bind(command)
  return {
    id: entryId(scope.manifest.id, command.id),
    title: () => command.title,
    keybinding: command.keybinding,
    when: enabled ? () => enabled(context()) : undefined,
    run: () => command.run(context()),
  }
}

function inserted(result: MentionInsert): ReturnType<MentionEntry["insert"]> {
  if (!result.attachment) return { text: result.text }
  return { attachment: { kind: "text", text: result.attachment.reference, label: result.text } }
}

function mentionSource(scope: BindingScope, provider: MentionProvider): MentionSource {
  return {
    id: entryId(scope.manifest.id, provider.id),
    search: async (query) => {
      const items = await provider.search(query, commandContext(scope.services))
      return items.map((item) => ({
        id: entryId(scope.manifest.id, `${provider.id}/${item.id}`),
        label: item.label,
        group: provider.label,
        insert: () => inserted(provider.insert(item)),
      }))
    },
  }
}

export function actionBindings(scope: BindingScope): Actions {
  const { registries, commands } = scope.services
  return {
    commands: {
      register: (command) => scope.sink.add(registries.commands, pluginCommandEntry(scope, command)),
      run: async (commandId) => {
        const tagged = entryId(scope.manifest.id, commandId)
        commands.trigger(commands.has(tagged) ? tagged : commandId)
      },
    },
    mentions: { register: (provider) => scope.sink.add(registries.mentions, mentionSource(scope, provider)) },
  }
}
