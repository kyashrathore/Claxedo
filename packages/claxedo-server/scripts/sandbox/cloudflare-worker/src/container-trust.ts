import { bounded, run, type WorkspaceContainer } from "./container-api"

const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"
const IMAGE_BUNDLE = "/etc/ssl/certs/ca-certificates.image.crt"

/** curl and git read the system bundle; Node and Python `requests` read only these. */
export const INTERCEPT_TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: INTERCEPT_CA,
  REQUESTS_CA_BUNDLE: SYSTEM_BUNDLE,
} as const

/**
 * Every container gets its own intercept CA, and a restored snapshot carries
 * the bundle its source container wrote, so the bundle is rebuilt from the
 * image's own copy each start instead of appended to. The CA file appears
 * once the first HTTPS intercept is registered.
 */
export const TRUST_INTERCEPT_CA = `[ -e ${IMAGE_BUNDLE} ] || { cp ${SYSTEM_BUNDLE} ${IMAGE_BUNDLE}.tmp && mv ${IMAGE_BUNDLE}.tmp ${IMAGE_BUNDLE}; }
timeout 10 sh -c 'until [ -s ${INTERCEPT_CA} ]; do sleep 0.1; done' && cat ${IMAGE_BUNDLE} ${INTERCEPT_CA} >${SYSTEM_BUNDLE}.tmp && mv ${SYSTEM_BUNDLE}.tmp ${SYSTEM_BUNDLE}`

/**
 * A reserved name no request resolves, intercepted on every container so the
 * platform mints the CA before any credential host is registered, and a host
 * registered later is intercepted without restarting the container.
 */
export const TRUST_ANCHOR_HOST = "claxedo-credential-trust.invalid"

/** Intercepts exactly the hosts a registration names; every other host keeps its direct route. */
export async function interceptCredentialHosts(container: WorkspaceContainer, hosts: readonly string[], egress: unknown) {
  for (const host of [TRUST_ANCHOR_HOST, ...hosts]) await container.interceptOutboundHttps(host, egress)
}

export async function trustInterceptCa(container: WorkspaceContainer) {
  const trusted = await bounded(run(container, ["sh", "-c", TRUST_INTERCEPT_CA]), "intercept CA trust", 15_000)
  if (trusted.exitCode !== 0) throw new Error("The container did not trust the credential interception CA")
}
