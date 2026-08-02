/**
 * Test double for the DURABLE CLI session token registry.
 *
 * Deliberately not `createInMemoryCliSessionTokenRegistry()`. That in-memory
 * registry is a second, hand-written implementation of the port: using it in a
 * hosted-composition test proves the routes work against *some* registry, which
 * is exactly the shape of assertion that stayed green while the hosted Worker
 * had no registry at all.
 *
 * This helper instead assembles the real production stack and fakes only the
 * one thing a unit test genuinely cannot have — the Convex deployment:
 *
 *   authorityCliSessionTokenRegistry   (real port adapter)
 *     └─ cliSessionTokenAuthority      (real Convex adapter, real arg mapping)
 *          └─ ConvexExecutor           (FAKE: dispatches in-process)
 *               └─ convex/cliSessionTokens.ts handlers   (real, incl. authz)
 *                    └─ fake `ctx.db`  (FAKE: in-memory table + indexes)
 *
 * So the service-token check, the argument wire names, the atomic rotation and
 * the owner scoping are all the shipping code paths. A rename or a dropped
 * argument anywhere in that chain fails the test.
 */

import { getFunctionName } from "convex/server"
import {
  active,
  recordMint,
  revoke,
  revokeForUser,
  revokeSession,
  rotate,
} from "../../../../convex/cliSessionTokens"
import { cliSessionTokenAuthority } from "../control-plane/adapters/convex/cli-session-tokens"
import { authorityCliSessionTokenRegistry } from "../control-plane/cli-session-registry"

type Row = Record<string, any> & { _id: string }

type ConvexFunction = { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> }

/**
 * Minimal stand-in for the Convex `ctx.db` surface these handlers use.
 *
 * Index names are honored rather than ignored: `withIndex` resolves the field
 * list from the schema shape below and applies the collected `eq`/`lte`
 * constraints, so a handler that queries the wrong index or forgets an owner
 * constraint does not silently pass.
 */
const INDEXES: Record<string, string[]> = {
  by_jti: ["jti"],
  by_user_session: ["token_identifier", "session_id"],
  by_token_identifier: ["token_identifier"],
  by_expires_at: ["expires_at"],
}

export function fakeCliSessionTokenDb(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((row) => [row._id, { ...row }]))
  let next = seed.length

  const db = {
    query(table: string) {
      if (table !== "cli_session_tokens") throw new Error(`unexpected table ${table}`)
      let matches = () => [...rows.values()]
      const result = {
        withIndex(name: string, build?: (q: any) => unknown) {
          const fields = INDEXES[name]
          if (!fields) throw new Error(`unknown index ${name}`)
          const constraints: { field: string; op: "eq" | "lte"; value: unknown }[] = []
          let cursor = 0
          const builder: any = {
            eq(field: string, value: unknown) {
              if (field !== fields[cursor]) throw new Error(`index ${name} field order violated at ${field}`)
              cursor += 1
              constraints.push({ field, op: "eq", value })
              return builder
            },
            lte(field: string, value: unknown) {
              if (field !== fields[cursor]) throw new Error(`index ${name} field order violated at ${field}`)
              cursor += 1
              constraints.push({ field, op: "lte", value })
              return builder
            },
          }
          build?.(builder)
          matches = () =>
            [...rows.values()].filter((row) =>
              constraints.every((constraint) =>
                constraint.op === "eq"
                  ? row[constraint.field] === constraint.value
                  : (row[constraint.field] as number) <= (constraint.value as number),
              ),
            )
          return result
        },
        async unique() {
          const found = matches()
          if (found.length > 1) throw new Error("not unique")
          return found[0] ?? null
        },
        async collect() {
          return matches()
        },
        async take(limit: number) {
          return matches().slice(0, limit)
        },
      }
      return result
    },
    async insert(table: string, value: Record<string, unknown>) {
      if (table !== "cli_session_tokens") throw new Error(`unexpected table ${table}`)
      next += 1
      const id = `cli_token_${next}`
      rows.set(id, { _id: id, ...value })
      return id
    },
    async patch(id: string, value: Record<string, unknown>) {
      rows.set(id, { ...rows.get(id)!, ...value })
    },
    async delete(id: string) {
      rows.delete(id)
    },
  }

  return { rows, db }
}

export function cliSessionHandler(fn: unknown) {
  return (fn as unknown as ConvexFunction)._handler
}

/**
 * A durable-shaped registry backed by the real Convex handlers.
 *
 * `serviceToken` must match `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` in the
 * environment, because the real `serviceMutation`/`serviceQuery` guards run —
 * a wrong token throws "Unauthenticated" exactly as it would in production.
 */
export function durableCliSessionTokenRegistry(input: { serviceToken?: string } = {}) {
  const { rows, db } = fakeCliSessionTokenDb()
  const byPath: Record<string, unknown> = {
    "cliSessionTokens:recordMint": recordMint,
    "cliSessionTokens:rotate": rotate,
    "cliSessionTokens:active": active,
    "cliSessionTokens:revoke": revoke,
    "cliSessionTokens:revokeSession": revokeSession,
    "cliSessionTokens:revokeForUser": revokeForUser,
  }
  const serviceToken = input.serviceToken ?? "service-secret"

  // Convex runs conflicting mutations as SERIALIZABLE transactions: a
  // transaction sees a consistent snapshot and a write conflict makes it retry,
  // so two mutations touching the same row never interleave mid-handler. The
  // fake `ctx.db` above has no such guarantee — every `await` in a handler is a
  // yield point — so without this queue a concurrency test would be scored by
  // microtask ordering rather than by the code under test, and would pass or
  // fail for reasons unrelated to correctness.
  //
  // Serializing dispatch restores the guarantee the production code is written
  // against. It does NOT paper over a broken implementation: an implementation
  // that validates OUTSIDE the transaction (the mint-then-revoke rotation this
  // replaced) still lets two racing refreshes both succeed under full
  // serialization, because both read "active" in an earlier, separate call.
  // What passes here is specifically a handler that re-validates inside the
  // same transaction that writes.
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const invoke = async (fn: unknown, args: Record<string, unknown>) => {
    // `convexApi` is `anyApi`, so the adapter's reference carries the module:
    // function path Convex itself would call. Resolving through that path means
    // a typo in the adapter (wrong module, renamed function) fails here rather
    // than passing against a hand-mapped double.
    const path = getFunctionName(fn as never)
    const handler = byPath[path]
    if (!handler) throw new Error(`unmapped convex function ${path}`)
    // The expected service token is a DEPLOYMENT env var on the Convex side,
    // not on the caller's — so it is bound only for the duration of the handler
    // call, which is exactly the trust boundary being modelled. The real
    // `requireControlPlaneService` guard runs against it, so a caller presenting
    // the wrong token gets the production "Unauthenticated".
    const previous = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = serviceToken
    try {
      return await cliSessionHandler(handler)({ db }, args)
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previous
    }
  }

  const dispatch = (fn: unknown, args: Record<string, unknown>) => serialize(() => invoke(fn, args))

  return {
    rows,
    db,
    registry: authorityCliSessionTokenRegistry(
      cliSessionTokenAuthority({
        serviceToken,
        executor: { query: dispatch, mutation: dispatch },
      }),
    ),
  }
}
