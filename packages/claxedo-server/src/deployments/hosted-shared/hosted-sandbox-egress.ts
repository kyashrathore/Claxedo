import type { HostedControlPlane } from "../../authority/hosted-services"
import { hostedControlPlaneOrigin } from "../../authority/adapters/worker/control-plane-origin"
import type { WorkspaceSandboxEgress } from "../../workspace/hosted-sandbox-input"
import { privateRepoHosts } from "../private-repo-hosts"

/**
 * A hosted plane's sandbox egress facts. The workspace routes and a refresh
 * of a running sandbox both build their allowlist from this, so the policy a
 * sandbox is created under and the one it is re-created under cannot differ.
 * The control-plane origin is the one the sandbox is given for management.
 */
export function hostedSandboxEgress(plane: Pick<HostedControlPlane, "services" | "env">): WorkspaceSandboxEgress {
  const { relay, defaultHomeRegion } = plane.services
  const origin = hostedControlPlaneOrigin(plane.env)
  return {
    ...(relay.relayUrl ? { relayUrl: relay.relayUrl } : {}),
    ...(relay.relayUrls ? { relayUrls: relay.relayUrls } : {}),
    ...(defaultHomeRegion ? { defaultHomeRegion } : {}),
    sandboxEgressExtraHosts: privateRepoHosts(plane.env),
    ...(origin ? { sandboxControlPlaneOrigin: origin } : {}),
  }
}
