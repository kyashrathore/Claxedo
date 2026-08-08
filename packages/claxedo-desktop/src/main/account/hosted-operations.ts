/**
 * The closed set of authenticated calls Electron main will make.
 *
 * This is the table `docs/tech-docs/desktop-hosted-operation-matrix.md`
 * describes, expressed as code. Every entry fixes a METHOD and a PATH in main.
 * The renderer supplies an operation NAME and parameters; it never supplies a
 * url, a method, or a header, because if it could, a renderer compromise would
 * be able to spend main's credential on any route the server exposes rather
 * than the fifteen the product actually uses.
 *
 * Parameters are substituted into the path by name and encoded. They cannot
 * introduce a new segment: `:id` is replaced by one `encodeURIComponent`d
 * value, so `../../admin` becomes a literal path component rather than a
 * traversal.
 *
 * Adding an operation means adding a matrix row AND an entry here.
 * `hosted-operations.test.ts` holds the two equal.
 */

export type HostedOperation = {
  method: "GET" | "POST"
  /** Path template; `:name` segments are filled from the caller's parameters. */
  path: string
  /** Parameter names that go in the body rather than the path. */
  body?: string[]
}

export const HOSTED_OPERATIONS = {
  "account.get": { method: "GET", path: "/api/claxedo/bootstrap" },
  "account.mode": { method: "GET", path: "/api/claxedo/mode" },
  "account.compatibility": { method: "GET", path: "/api/claxedo/compatibility" },
  // No idempotency key. The app registry says "the idempotency key for that
  // lives in main"; it does not — nothing in this process, for any operation,
  // has ever had one, and this table has no way to express one. The route
  // dedupes nothing either: `POST /api/auth/cli/exchange`
  // (`routes/hosted/device-auth.ts`) mints from the BEARER and never reads the
  // body at all, so `code` is declared here and ignored there, and every call
  // is a fresh, separately-revocable session pair. Harmless only because the
  // renderer cannot reach it — see `RENDERER_WITHHELD_OPERATIONS` — and no
  // main-side caller exists.
  "account.cliExchange": { method: "POST", path: "/api/auth/cli/exchange", body: ["code"] },
  "workspace.list": { method: "GET", path: "/api/workspace" },
  "workspace.resolve": { method: "GET", path: "/api/workspace/resolve" },
  // `projectName`/`workspaceName`, not `displayName`. The create body is a
  // strict schema, so an undeclared field is a 400 for the whole request rather
  // than a field the server ignores — `displayName` made this operation
  // unusable from the day it was written. The connected-repository form
  // (`connectionId` + a `repo` object, both or neither) is deliberately absent:
  // parameters here are scalars, so that create shape is not expressible as a
  // named operation and must not be half-declared.
  //
  // NO IDEMPOTENCY KEY, and one cannot be added from this side. The matrix once
  // classified this row `idempotency-key`; there is no key anywhere. This table
  // expresses a request as method + path + declared body — there is no header
  // seam — and the route's body schema is `.strict()` with no idempotency field
  // (`createCloudBody`, `routes/hosted/workspace.ts`), so a key declared here
  // would 400 every create rather than dedupe a retry. That is the same failure
  // `displayName` caused above. Until the route accepts one, this operation is
  // genuinely `unsafe`: an uncertain response must be surfaced, never retried,
  // because a retry provisions a second billable sandbox. Nothing retries it
  // today — `account-service.run` performs exactly one fetch and no renderer
  // surface names this operation yet — which is what keeps the gap latent
  // rather than live. `isSafeOperation` in the app registry already answers
  // false for it, and that is the property a retry loop must consult.
  "workspace.create": {
    method: "POST",
    path: "/api/workspace/create",
    body: ["projectId", "projectName", "workspaceName", "repoUrl"],
  },
  // `approved` is not decoration. Every lifecycle operation except `stop`
  // refuses with 409 unless the caller states the approval explicitly, and an
  // operation that declares no body can never state it.
  "workspace.lifecycle": {
    method: "POST",
    path: "/api/workspace/:id/lifecycle/:operation",
    body: ["approved", "checkpointId"],
  },
  "workspace.checkpoints.list": { method: "GET", path: "/api/workspace/:id/checkpoints" },
  "workspace.checkpoints.restore": {
    method: "POST",
    path: "/api/workspace/:id/checkpoints/:checkpointId/restore",
    body: ["approved"],
  },
  "workspace.connection.mint": { method: "GET", path: "/api/workspace/:id/connection" },
  "workspace.connection.refresh": { method: "POST", path: "/api/workspace/:id/connection/refresh" },
  // MAIN-ONLY. `publicKey` and `signature` are the machine identity, and the
  // route stores whatever public key it is handed — so a caller that supplies
  // them enrolls a machine whose private half nobody else holds. The only
  // legitimate caller is `setupHostConnector`, which is given
  // `account.service.run` in-process and fills these from the key
  // `host-connector/machine-identity.ts` owns; the renderer reaches the same
  // feature through the connector's own zero-argument IPC. That refusal is
  // enforced by `RENDERER_WITHHELD_OPERATIONS` in `account-ipc.ts`, which is
  // where the whole argument is written down.
  //
  // Retry IS idempotent, and by the machine identity rather than a key the
  // caller invents: `enrollForUser` patches the existing row for the same
  // `host_id` instead of inserting a second one.
  "host.enrollCurrentMachine": {
    method: "POST",
    path: "/api/claxedo/host/enrollments",
    body: ["hostId", "publicKey", "requestId", "signature", "displayName"],
  },
  // `enrollmentNonce`, not `enrollmentRequest`: an operation name ending in
  // "Request" trips the generic-passthrough guard, which is watching for
  // exactly the `proxyRequest`/`hostedFetch` shape this whole table exists to
  // prevent. The guard was right and "nonce" is the more accurate word.
  //
  // The nonce the machine signs, and the presence beat. Both are signed-only
  // routes, so the connector reaches them through the account rather than
  // holding a bearer of its own — the machine key proves the MACHINE, the
  // account bearer proves the owner, and enrollment needs both.
  "host.enrollmentNonce": { method: "POST", path: "/api/claxedo/host/enrollments/requests", body: ["hostId"] },
  "host.enrollmentHeartbeat": {
    method: "POST",
    path: "/api/claxedo/host/enrollments/heartbeat",
    body: ["hostId", "signature", "ttlMs"],
  },
} as const satisfies Record<string, HostedOperation>

export type HostedOperationName = keyof typeof HOSTED_OPERATIONS

export type ResolvedRequest = { method: string; path: string; body?: Record<string, unknown> }

export class UnknownHostedOperation extends Error {}
export class MissingOperationParameter extends Error {}

/**
 * Turn a named operation plus parameters into the one request it stands for.
 *
 * Rejects an unknown name rather than falling through to a default. There is no
 * default — the whole design is that an operation nobody wrote down cannot be
 * performed.
 */
export function resolveHostedOperation(
  name: string,
  input: Record<string, unknown> = {},
): ResolvedRequest {
  const operation = (HOSTED_OPERATIONS as Record<string, HostedOperation | undefined>)[name]
  if (!operation) throw new UnknownHostedOperation(`no hosted operation named "${name}"`)

  const path = operation.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, key: string) => {
    const value = input[key]
    if (value === undefined || value === null || value === "") {
      throw new MissingOperationParameter(`operation "${name}" requires ${key}`)
    }
    // Encoded, so a parameter cannot add a path segment or a query string.
    return encodeURIComponent(String(value))
  })

  if (!operation.body) return { method: operation.method, path }

  // Only the declared fields. A caller passing extra keys is not an error worth
  // failing on, but those keys must not reach the server — an undeclared field
  // is one nobody reviewed.
  const body: Record<string, unknown> = {}
  for (const key of operation.body) {
    if (input[key] !== undefined) body[key] = input[key]
  }
  return { method: operation.method, path, body }
}

/** The IPC channel a named operation travels on. One per operation, by name. */
export function hostedOperationChannel(name: HostedOperationName) {
  return `claxedo.account.operation:${name}`
}
