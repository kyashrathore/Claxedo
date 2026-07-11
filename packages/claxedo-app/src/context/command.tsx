// Claxedo promotes upstream command triggers through the typed shell command bus while preserving the upstream command API.

import { createEffect, onCleanup, type JSX } from "solid-js"
import {
  CommandProvider as UpstreamCommandProvider,
  useCommand as useUpstreamCommand,
} from "./command-palette"
import { CommandBusProvider, useCommandBus, useCommandBusOptional } from "@claxedo/shell/contributions/command-bus-provider"
import {
  agentCommandFromEvent,
  legacyCommandTrigger,
  legacyCommandTriggerType,
  serverCommandTriggerFromEvent,
  type CommandTriggerCompatSource,
  type LegacyCommandTriggerCommand,
} from "@claxedo/shell/contributions/compat-command-trigger"
import { trustedAgentContributionBundleFromEvent } from "@claxedo/shell/contributions/registry"
import { contentSurfaceRegistry } from "@claxedo/shell/contributions/first-party-content-surfaces"
import { useGlobalSDK } from "@/context/global-sdk"

export * from "./command-palette"

export function CommandProvider(props: { children: JSX.Element }): JSX.Element {
  return (
    <CommandBusProvider>
      <UpstreamCommandProvider>
        <LegacyCommandBusBridge>
          <ServerCommandBusBridge>
            <TrustedAgentContributionBridge>
              {props.children}
            </TrustedAgentContributionBridge>
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
  createEffect(() => {
    const unregister = bus.register<LegacyCommandTriggerCommand>(legacyCommandTriggerType, (event) => {
      command.trigger(event.payload.id, event.payload.legacySource)
    })
    onCleanup(unregister)
  })
  return props.children
}

function ServerCommandBusBridge(props: { children: JSX.Element }): JSX.Element {
  const bus = useCommandBus()
  const globalSDK = useGlobalSDK()
  createEffect(() => {
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
    const unsubscribeCompat = globalSDK.event.on(legacyCommandTriggerType, dispatch)
    const unsubscribeTui = globalSDK.event.on("tui.command.execute", dispatch)
    const unsubscribeRemoteAgent = globalSDK.event.on("remote-agent.command.execute", dispatchAgentCommand)
    const unsubscribeVoiceAgent = globalSDK.event.on("voice-agent.command.execute", dispatchAgentCommand)
    onCleanup(() => {
      unsubscribeCompat()
      unsubscribeTui()
      unsubscribeRemoteAgent()
      unsubscribeVoiceAgent()
    })
  })
  return props.children
}

function TrustedAgentContributionBridge(props: { children: JSX.Element }): JSX.Element {
  const globalSDK = useGlobalSDK()
  createEffect(() => {
    const dispatch = (event: unknown) => {
      const bundle = trustedAgentContributionBundleFromEvent(event)
      if (!bundle) return
      contentSurfaceRegistry.addTrustedAgentContributions(bundle)
    }
    const unsubscribe = globalSDK.event.on("trusted-agent.contributions.register", dispatch)
    onCleanup(unsubscribe)
  })
  return props.children
}
