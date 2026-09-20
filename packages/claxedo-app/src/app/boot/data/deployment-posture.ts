import { queryClient } from "@/platform/query/query-client"
import { deploymentPostureQuery } from "@/platform/query/control-plane"

/**
 * How long the entry will wait for the declaration before rendering anyway.
 *
 * Until `render()` runs, the only thing on screen is the static spinner in
 * `index.html`, which has no text, no reason and no retry. So the pre-render
 * read buys one thing — a warm cache, so the gate's first frame is the answer
 * rather than a hold — and the moment it costs more than it buys, the tree
 * below is the better place to be waiting: it owns the retry, the reason and
 * the surface that reports an unreachable server.
 */
const RENDER_DEADLINE_MS = 1_500

/**
 * Put the server's posture declaration in the query cache before `render()`.
 *
 * `startBrowserAuth` and the sign-in gate both read it, and both act before
 * the shell can paint: resolving it only from inside the tree would start a
 * provider SDK against a loopback daemon for one tick, or paint an anonymous
 * shell on a deployment that requires a signed session.
 *
 * Never rejects and never outlives {@link RENDER_DEADLINE_MS}. A server that
 * cannot be reached, one that declares no posture, and one still answering
 * when the deadline passes all leave the answer unresolved, and every reader
 * treats that as "not declared" rather than as a posture. The query keeps
 * running under the same key, so the in-tree reader adopts the same request
 * rather than starting a second one.
 */
export async function resolveDeploymentPosture(input: {
  baseUrl: string | undefined
  request?: typeof globalThis.fetch
}): Promise<boolean | undefined> {
  const declared = queryClient.fetchQuery(deploymentPostureQuery(input)).catch(() => undefined)
  let expire: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    expire = setTimeout(() => resolve(undefined), RENDER_DEADLINE_MS)
  })
  try {
    return await Promise.race([declared, deadline])
  } finally {
    clearTimeout(expire)
  }
}
