import { createContext, useContext } from "solid-js"
import type { JSX } from "@solidjs/web"
import { createCommandBus, type CommandBus } from "./command-bus"

const CommandBusContext = createContext<CommandBus | null>(null)

export function CommandBusProvider(props: { bus?: CommandBus; children: JSX.Element }): JSX.Element {
  return <CommandBusContext value={props.bus ?? createCommandBus()}>{props.children}</CommandBusContext>
}

export function useCommandBus() {
  const bus = useContext(CommandBusContext)
  if (!bus) throw new Error("useCommandBus must be used inside <CommandBusProvider>")
  return bus
}

export function useCommandBusOptional() {
  return useContext(CommandBusContext) ?? undefined
}
