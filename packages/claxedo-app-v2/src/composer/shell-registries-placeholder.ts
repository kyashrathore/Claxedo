import { createContext, useContext } from "solid-js"
import type { CommandEntry, MentionSource, Registry, ShellRegistries } from "@/shell/types"

export type ComposerRegistries = Pick<ShellRegistries, "commands" | "mentions">

function emptyRegistry<Entry>(): Registry<Entry> {
  return { list: () => [], add: () => () => {} }
}

const none: ComposerRegistries = {
  commands: emptyRegistry<CommandEntry>(),
  mentions: emptyRegistry<MentionSource>(),
}

export const ShellRegistriesContext = createContext<ComposerRegistries>()

export function useShellRegistries(): ComposerRegistries {
  return useContext(ShellRegistriesContext) ?? none
}
