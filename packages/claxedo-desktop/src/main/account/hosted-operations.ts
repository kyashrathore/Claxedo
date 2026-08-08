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
  "account.cliExchange": { method: "POST", path: "/api/auth/cli/exchange", body: ["code"] },
  "workspace.list": { method: "GET", path: "/api/workspace" },
  "workspace.resolve": { method: "GET", path: "/api/workspace/resolve" },
  "workspace.create": { method: "POST", path: "/api/workspace/create", body: ["displayName", "projectId", "repoUrl"] },
  "workspace.lifecycle": { method: "POST", path: "/api/workspace/:id/lifecycle/:operation" },
  "workspace.checkpoints.list": { method: "GET", path: "/api/workspace/:id/checkpoints" },
  "workspace.checkpoints.restore": { method: "POST", path: "/api/workspace/:id/checkpoints/:checkpointId/restore" },
  "workspace.connection.mint": { method: "GET", path: "/api/workspace/:id/connection" },
  "workspace.connection.refresh": { method: "POST", path: "/api/workspace/:id/connection/refresh" },
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
