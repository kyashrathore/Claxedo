import type { CommandResult, WorkGraphContext } from "../contracts"
import type {
  AtomicWorkGraphStore,
  OwnerQuery,
  WorkGraphCommandHandler,
  WorkGraphCommandHandlers,
  WorkGraphCommandRequestOf,
  WorkGraphCommandType,
} from "../ports"

type QueryInput<Query> = Query extends (
  context: WorkGraphContext,
  input: Readonly<infer Input>,
) => Promise<unknown> ? Input : never
type QueryResult<Query> = Query extends (...input: never[]) => Promise<infer Result> ? Result : never
type QueryCapabilityMap = Readonly<Record<string, Readonly<Record<string, OwnerQuery<never, unknown>>>>>

export type WorkGraphService<Commands extends Partial<WorkGraphCommandHandlers>, Queries extends object> = Readonly<{
  queries: Queries
  execute: <Type extends keyof Commands & WorkGraphCommandType>(
    context: WorkGraphContext,
    request: WorkGraphCommandRequestOf<Type>,
  ) => Promise<CommandResult>
  query: <
    Capability extends keyof Queries,
    Operation extends keyof Queries[Capability],
  >(
    context: WorkGraphContext,
    capability: Capability,
    operation: Operation,
    input: QueryInput<Queries[Capability][Operation]>,
  ) => Promise<QueryResult<Queries[Capability][Operation]>>
}>

export function createWorkGraphService<
  Commands extends Partial<WorkGraphCommandHandlers>,
  Queries extends object,
>(store: AtomicWorkGraphStore<Commands, Queries>): WorkGraphService<Commands, Queries> {
  return {
    queries: store.queries,
    execute: async <Type extends keyof Commands & WorkGraphCommandType>(
      context: WorkGraphContext,
      request: WorkGraphCommandRequestOf<Type>,
    ) => {
      // TypeScript cannot preserve the correlation between a discriminated union
      // and a mapped handler lookup. The contracts guarantee it at this boundary.
      const handler = store.commands[request.command.type] as WorkGraphCommandHandler
      return handler(context, request)
    },
    query: async <
      Capability extends keyof Queries,
      Operation extends keyof Queries[Capability],
    >(
      context: WorkGraphContext,
      capability: Capability,
      operation: Operation,
      input: QueryInput<Queries[Capability][Operation]>,
    ): Promise<QueryResult<Queries[Capability][Operation]>> => {
      const queries = store.queries as QueryCapabilityMap
      const query = queries[String(capability)]?.[String(operation)] as OwnerQuery<
        QueryInput<Queries[Capability][Operation]>,
        QueryResult<Queries[Capability][Operation]>
      >
      return query(context, input)
    },
  }
}
