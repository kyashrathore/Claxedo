/**
 * A path param of the route the handler is mounted under. Hono types
 * `param()` as possibly absent on a context that does not carry its route; the
 * router only reaches the handler on a match, so absence is a mount mistake.
 */
export function routeParam(c: { req: { param(name: string): string | undefined } }, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) throw new Error(`Route param ${name} is not on the mounted path`)
  return value
}
