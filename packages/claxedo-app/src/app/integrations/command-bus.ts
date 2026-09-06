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
    // Not generic, for the same reason `dispatch` is not: the bus is keyed by a
    // string and nothing on this path checks that a dispatched payload matches
    // the shape a handler named. A `register<TCommand>` let the caller name that
    // shape anyway, and the handler then had to be asserted back into a
    // `CommandHandler` to be stored — a claim the bus cannot keep. A handler
    // reads its own payload off `Command` (see `legacyCommandTriggerPayload`).
    register(type: Command["type"], handler: CommandHandler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler])
      return () => {
        const next = (handlers.get(type) ?? []).filter((item) => item !== handler)
        if (next.length === 0) {
          handlers.delete(type)
          return
        }
        handlers.set(type, next)
      }
    },
    // Not generic: dispatch reads only `type`, and a type parameter here would
    // have let a caller NAME a command shape that nothing on this path checks.
    async dispatch(command: Command) {
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
