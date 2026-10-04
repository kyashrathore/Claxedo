import { brokerErrorBody } from "./errors.js"

const PREFIX = "/bindings/"

/** The route pattern a Hono-style composition mounts the returned handler on. */
export const BROKER_ROUTE_PATTERN = `${PREFIX}*`

/**
 * Whether a path belongs to the broker, for a composition's CORS policy.
 *
 * The broker turns a runtime token into the operator's stored key, so a
 * loopback page granted an `Access-Control-Allow-Origin` here could spend it
 * from a browser. Every composition that mounts the broker must withhold one.
 */
export function isBrokerPath(path: string) {
  return path.startsWith(PREFIX)
}

/**
 * The broker behind the one gate that keeps it off the network.
 *
 * A signed deployment's unsigned-local guard steps aside and the server may
 * bind `0.0.0.0`, so this peer check is what stands between the credential
 * proxy and a remote caller. Serving a remote runtime waits on a signed runtime
 * token that proves which lease is calling; a bearer the broker itself minted
 * for a loopback harness does not.
 *
 * `isLoopback` is supplied by the composition: this package is a leaf and the
 * peer-address reader belongs to the server it is mounted in.
 */
export function loopbackBrokerRoutes(input: {
  broker: (request: Request) => Response | Promise<Response>
  isLoopback: (request: Request) => boolean
}) {
  return async (request: Request): Promise<Response> => input.isLoopback(request)
    ? input.broker(request)
    : Response.json(brokerErrorBody("loopback_required"), { status: 403 })
}
