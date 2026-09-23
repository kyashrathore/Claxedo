import { createSignal, type Accessor } from "solid-js"
import type { CommandEntry } from "@/shell/types"

export type Commands = {
  readonly list: Accessor<readonly CommandEntry[]>
  readonly keybind: (id: string) => string | undefined
  readonly setKeybind: (id: string, keybind: string) => void
  readonly resetKeybinds: () => void
  readonly hasOverrides: Accessor<boolean>
  readonly captureEnabled: (on: boolean) => void
}

export type TerminalAgent = { readonly id: string; readonly label: string; readonly hint: string; readonly defaultCommand: string }

export type TerminalCustomCommand = { readonly id: string; readonly name: string; readonly command: string }

export type TerminalCommandSet = { readonly agents: Readonly<Record<string, string>>; readonly custom: readonly TerminalCustomCommand[] }

export type TerminalCommands = {
  readonly agents: readonly TerminalAgent[]
  readonly commands: Accessor<TerminalCommandSet>
  readonly save: (next: TerminalCommandSet) => void
  readonly reset: () => void
}

export function useCommands(): Commands {
  const [overrides, setOverrides] = createSignal<Readonly<Record<string, string>>>({})
  return {
    list: () => [],
    keybind: (id) => overrides()[id],
    setKeybind: (id, keybind) => setOverrides((current) => ({ ...current, [id]: keybind })),
    resetKeybinds: () => setOverrides({}),
    hasOverrides: () => Object.keys(overrides()).length > 0,
    captureEnabled: () => undefined,
  }
}

export function useTerminalCommands(): TerminalCommands {
  const [commands, setCommands] = createSignal<TerminalCommandSet>({ agents: {}, custom: [] })
  return { agents: [], commands, save: setCommands, reset: () => setCommands({ agents: {}, custom: [] }) }
}
