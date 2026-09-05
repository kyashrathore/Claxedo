// Claxedo promotes upstream command triggers through the typed shell command bus while preserving the upstream command API.

import { createEffect, onCleanup, type JSX } from "solid-js"
import {
  CommandProvider as UpstreamCommandProvider,
  useCommand as useUpstreamCommand,
} from "./command-palette"
import { CommandBusProvider, useCommandBus, useCommandBusOptional } from "@/app/integrations/command-bus-provider"
import {
  legacyCommandTrigger,
  legacyCommandTriggerType,
  type CommandTriggerCompatSource,
  type LegacyCommandTriggerCommand,
} from "@/app/integrations/compat-command-trigger"

export * from "./command-palette"

export function CommandProvider(props: { children: JSX.Element }): JSX.Element {
  return (
    <CommandBusProvider>
      <UpstreamCommandProvider>
        <LegacyCommandBusBridge>
          {props.children}
        </LegacyCommandBusBridge>
      </UpstreamCommandProvider>
    </CommandBusProvider>
  )
}

export function useCommand() {
  const command = useUpstreamCommand()
  const bus = useCommandBusOptional()
  return new Proxy(command, {
    get(target, property, receiver) {
      if (property !== "trigger") return Reflect.get(target, property, receiver)
      return (id: string, source?: CommandTriggerCompatSource) => {
        if (!bus) {
          target.trigger(id, source)
          return
        }
        void bus.dispatch(legacyCommandTrigger(id, source))
      }
    },
  }) as typeof command
}

function LegacyCommandBusBridge(props: { children: JSX.Element }): JSX.Element {
  const bus = useCommandBus()
  const command = useUpstreamCommand()
  createEffect(() => {
    const unregister = bus.register<LegacyCommandTriggerCommand>(legacyCommandTriggerType, (event) => {
      command.trigger(event.payload.id, event.payload.legacySource)
    })
    onCleanup(unregister)
  })
  return props.children
}
