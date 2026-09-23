import { useQuery } from "@tanstack/solid-query"
import { useDeploymentPosture } from "@/app/connection/deployment-posture"
import { useServer } from "@/app/connection/server"
import { serverHealthQueryOptions } from "@/app/connection/server-health"
import { usePlatform } from "@/platform/runtime/platform-provider"

/**
 * Whether the active server runs work on its own filesystem, which is what
 * separates the two products: a self-hosted node or the desktop's embedded
 * server keeps projects, credentials and harnesses on its machine; the hosted
 * plane keeps harness keys under its own auth route and runs work in
 * sandboxes.
 *
 * The server's health document is its own statement and wins wherever it is
 * made. Where it states nothing, the posture declaration is what is left: a
 * central that issues sessions is not running projects off this machine.
 */
export function useServerProduct() {
  const server = useServer()
  const platform = usePlatform()
  const posture = useDeploymentPosture()
  const health = useQuery(() =>
    serverHealthQueryOptions({
      server: { url: server.url },
      fetch: platform.fetch ?? globalThis.fetch,
      enabled: !!server.url,
    }),
  )
  return {
    localExecution: () => health.data?.localExecution ?? posture.issuesSessions() !== true,
    /** Whether the server has answered; until then `localExecution` is the posture's guess. */
    known: () => !health.isLoading,
  }
}
