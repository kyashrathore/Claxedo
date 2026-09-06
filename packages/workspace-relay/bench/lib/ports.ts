/**
 * Port allocation for bench runs.
 *
 * Every bench entrypoint needs a free localhost port to hand a relay or a
 * target before starting it, and each one carried its own byte-identical copy
 * of this — one of which is now the only place the shutdown is awaited. That
 * await matters: `Bun.Server.stop()` is asynchronous, so returning the number
 * before the probe has actually released the port hands the caller a port that
 * may still be bound.
 */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = probe.port ?? 0
  await probe.stop(true)
  return port
}
