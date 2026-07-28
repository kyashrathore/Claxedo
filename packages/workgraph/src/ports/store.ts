import type {
  CommandResult,
  OperationID,
  WorkGraphCommand,
  WorkGraphCommandRequest,
  WorkGraphContext,
} from "../contracts"

export type AtomicCommandInput = Readonly<{ operationId: OperationID }>

/** A domain command executed atomically by the selected storage adapter. */
export type AtomicCommand<Input extends AtomicCommandInput, Result> = (
  context: WorkGraphContext,
  input: Readonly<Input>,
) => Promise<Result>

/** A read that is always scoped by the trusted owner context. */
export type OwnerQuery<Input, Result> = (context: WorkGraphContext, input: Readonly<Input>) => Promise<Result>

export type WorkGraphCommandType = WorkGraphCommand["type"]

export type WorkGraphCommandRequestOf<Type extends WorkGraphCommandType> = Readonly<{
  operationId: OperationID
  command: Extract<WorkGraphCommand, { type: Type }>
}>

/** One atomic persistence handler per public command discriminator. */
export type WorkGraphCommandHandlers = {
  readonly [Type in WorkGraphCommandType]: AtomicCommand<WorkGraphCommandRequestOf<Type>, CommandResult>
}

export type WorkGraphCommandHandler = AtomicCommand<WorkGraphCommandRequest, CommandResult>

/**
 * Capability maps are supplied by the domain layer (streams, work, runs,
 * decisions, and so on). Keeping the maps generic preserves concrete command
 * signatures without turning the port into a SQL-shaped repository.
 */
export type AtomicWorkGraphStore<Commands extends object = object, Queries extends object = object> = Readonly<{
  commands: Commands
  queries: Queries
}>

type AtomicCapabilities<Capabilities> = {
  readonly [Capability in keyof Capabilities]: {
    readonly [Operation in keyof Capabilities[Capability]]: Capabilities[Capability][Operation] extends AtomicCommand<
      infer Input,
      infer Result
    >
      ? AtomicCommand<Input, Result>
      : never
  }
}

type QueryCapabilities<Capabilities> = {
  readonly [Capability in keyof Capabilities]: {
    readonly [Operation in keyof Capabilities[Capability]]: Capabilities[Capability][Operation] extends OwnerQuery<
      infer Input,
      infer Result
    >
      ? OwnerQuery<Input, Result>
      : never
  }
}

export function defineAtomicWorkGraphStore<Commands extends object, Queries extends object>(
  store: AtomicWorkGraphStore<Commands, Queries> &
    AtomicWorkGraphStore<AtomicCapabilities<Commands>, QueryCapabilities<Queries>>,
): AtomicWorkGraphStore<Commands, Queries> {
  return store
}
