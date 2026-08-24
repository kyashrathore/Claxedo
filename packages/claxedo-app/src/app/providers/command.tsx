// Claxedo promotes upstream command triggers through the typed shell command bus while preserving the upstream command API.

import { onCleanup } from "solid-js"
import type { JSX } from "@solidjs/web"
import { CommandProvider as UpstreamCommandProvider, useCommand as useUpstreamCommand } from "./command-palette"
import { CommandBusProvider, useCommandBus, useCommandBusOptional } from "@/app/integrations/command-bus-provider"
import {
  agentCommandFromEvent,
  legacyCommandTrigger,
  legacyCommandTriggerType,
  serverCommandTriggerFromEvent,
  type CommandTriggerCompatSource,
  type LegacyCommandTriggerCommand,
} from "@/app/integrations/compat-command-trigger"
import { trustedAgentContributionBundleFromEvent } from "@/app/integrations/registry"
import { contentSurfaceRegistry } from "@/app/integrations/first-party-content-surfaces"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"

export * from "./command-palette"

export function CommandProvider(props: { children: JSX.Element }): JSX.Element {
  return (
    <CommandBusProvider>
      <UpstreamCommandProvider>
        <LegacyCommandBusBridge>
          <ServerCommandBusBridge>
            <TrustedAgentContributionBridge>{props.children}</TrustedAgentContributionBridge>
          </ServerCommandBusBridge>
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
  const unregister = bus.register<LegacyCommandTriggerCommand>(legacyCommandTriggerType, (event) => {
    command.trigger(event.payload.id, event.payload.legacySource)
  })
  onCleanup(unregister)
  return props.children
}

function ServerCommandBusBridge(props: { children: JSX.Element }): JSX.Element {
  const bus = useCommandBus()
  const globalSDK = useGlobalSDK()
  const dispatch = (event: unknown) => {
    const command = serverCommandTriggerFromEvent(event)
    if (!command) return
    void bus.dispatch(command)
  }
  const dispatchAgentCommand = (event: unknown) => {
    const command = agentCommandFromEvent(event)
    if (!command) return
    void bus.dispatch(command)
  }
  // The event-bus primitive binds its own owner cleanup. Registering from a
  // tracked effect made that internal `onCleanup` illegal in Solid 2; these
  // context objects are stable for the bridge's lifetime, so component setup
  // is the correct subscription boundary.
  globalSDK.event.on(legacyCommandTriggerType, dispatch)
  globalSDK.event.on("tui.command.execute", dispatch)
  globalSDK.event.on("remote-agent.command.execute", dispatchAgentCommand)
  globalSDK.event.on("voice-agent.command.execute", dispatchAgentCommand)
  return props.children
}

function TrustedAgentContributionBridge(props: { children: JSX.Element }): JSX.Element {
  const globalSDK = useGlobalSDK()
  const dispatch = (event: unknown) => {
    const bundle = trustedAgentContributionBundleFromEvent(event)
    if (!bundle) return
    contentSurfaceRegistry.addTrustedAgentContributions(bundle)
  }
  globalSDK.event.on("trusted-agent.contributions.register", dispatch)
  return props.children
}
