import { trimToUndefined } from "@claxedo/helpers/string"
import type { HostedWorkerEnv } from "../../provider-neutral-hosted-services"

/**
 * The origin a hosted sandbox is told to reach this control plane at: the
 * deployment's one public origin, whose app Worker forwards `/api` and
 * `/internal` here; `CLAXEDO_PUBLIC_URL` stands in for a deployment that runs
 * no Better Auth.
 */
export function hostedControlPlaneOrigin(env: HostedWorkerEnv): string | undefined {
  return trimToUndefined(env.BETTER_AUTH_URL) ?? trimToUndefined(env.CLAXEDO_PUBLIC_URL)
}
