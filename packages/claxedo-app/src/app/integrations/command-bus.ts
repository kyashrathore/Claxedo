export type CommandSource =
  | { kind: "ui"; surface?: string }
  | { kind: "slash"; sessionId?: string }
  | { kind: "voice-agent"; agentId: string }
  | { kind: "remote-agent"; agentId: string }
  | { kind: "server"; eventId?: string }

export type Command<TType extends string = string, TPayload = unknown> = {
  type: TType
  payload: TPayload
  source: CommandSource
}

export type CommandHandler<TCommand extends Command = Command> = (command: TCommand) => void | Promise<void>

export function createCommandBus() {
  const handlers = new Map<string, CommandHandler[]>()

  return {
    register<TCommand extends Command>(type: TCommand["type"], handler: CommandHandler<TCommand>) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler as CommandHandler])
      return () => {
        const next = (handlers.get(type) ?? []).filter((item) => item !== handler)
        if (next.length === 0) {
          handlers.delete(type)
          return
        }
        handlers.set(type, next)
      }
    },
    async dispatch<TCommand extends Command>(command: TCommand) {
      for (const handler of handlers.get(command.type) ?? []) {
        await handler(command)
      }
    },
    registeredTypes() {
      return [...handlers.keys()]
    },
  }
}

export type CommandBus = ReturnType<typeof createCommandBus>
