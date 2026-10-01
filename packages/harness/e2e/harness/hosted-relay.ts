import { HOSTED_SIGNING_PRIVATE_KEY, HOSTED_SIGNING_PUBLIC_KEY } from "./hosted-keys"
import { startWorkerdRelay } from "./workerd-relay"

export function startHostedRelay(input: { root: string; port: number; controlPlaneUrl: string; certificate: string }) {
  return startWorkerdRelay({
    ...input,
    resolverToken: "hosted-e2e-relay-resolver-token",
    runtimePublicPem: HOSTED_SIGNING_PUBLIC_KEY,
    signingKeys: { privatePem: HOSTED_SIGNING_PRIVATE_KEY, publicPem: HOSTED_SIGNING_PUBLIC_KEY },
  })
}
