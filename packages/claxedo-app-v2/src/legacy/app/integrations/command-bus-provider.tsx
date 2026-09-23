import { createContext, useContext, type JSX } from "solid-js"
import { createCommandBus, type CommandBus } from "./command-bus"

const CommandBusContext = createContext<CommandBus | undefined>(undefined)

export function CommandBusProvider(props: { bus?: CommandBus; children: JSX.Element }): JSX.Element {
  return (
    <CommandBusContext.Provider value={props.bus ?? createCommandBus()}>
      {props.children}
    </CommandBusContext.Provider>
  )
}

export function useCommandBus() {
  const bus = useContext(CommandBusContext)
  if (!bus) throw new Error("useCommandBus must be used inside <CommandBusProvider>")
  return bus
}

export function useCommandBusOptional() {
  return useContext(CommandBusContext)
}
