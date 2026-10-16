import { WorkerEntrypoint } from "cloudflare:workers"
import type { Request as WorkerRequest, Response as WorkerResponse } from "@cloudflare/workers-types"
import { readRegistrations } from "./egress-store"
import { forwardCredential } from "./outbound-credentials"
import { domRequest, workerResponse } from "./runtime-request"
import type { WorkerEnv } from "./worker-env"

/** What a sandbox's credential hosts are intercepted with, from `ctx.exports`. */
export class CredentialEgress extends WorkerEntrypoint<WorkerEnv, { sandboxId: string }> {
  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    return workerResponse(await forwardCredential(domRequest(request), {
      registrations: () => readRegistrations(this.env.EGRESS_SECRETS, this.ctx.props.sandboxId),
    }))
  }
}
