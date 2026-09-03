/**
 * Convex-backed `UsageLedger` for the hosted control plane's
 * `GET /api/claxedo/usage` / `POST /api/claxedo/usage/sync` surface.
 *
 * Built from the SAME two env bindings `composeWorkerAuthority`
 * (`authority/adapters/worker/hosted-compose.ts`) already requires to answer
 * for workspace authority: `CLAXEDO_WORKSPACE_AUTHORITY_URL` and
 * `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN`. Every hosted composition that has
 * signed workspace authority today gets those from Convex, so a plane that
 * can open a workspace can also report usage for it — this never asks for a
 * binding the authority itself does not already depend on.
 *
 * Returns `undefined` when either binding is absent rather than fabricating
 * a ledger over a store that is not there: a composition that swaps
 * workspace authority for a different backend (e.g. the in-progress
 * Better-Auth + D1 candidate, `hosted-workerd/better-auth-d1-*.cf.ts`) has
 * neither var set, and the usage route stays unmounted for it, exactly as it
 * is today, instead of mounting a route that would 503 on every call.
 */
import { createConvexUsageLedger } from "../../authority/adapters/convex/usage-ledger"
import type { UsageLedger } from "@claxedo/server-core/usage/routes"
import type { HostedWorkerEnv } from "../../authority/hosted-services"

function clean(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function hostedUsageLedger(env: HostedWorkerEnv): UsageLedger | undefined {
  const url = clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!url || !serviceToken) return undefined
  return createConvexUsageLedger({ url, serviceToken })
}
