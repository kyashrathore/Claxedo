/**
 * The request headers an operator-declared provider may carry beside its
 * credential: routing and attribution metadata only. Anything else is either a
 * credential or unknown, and an unknown header is refused rather than trusted,
 * because its value travels in the runtime snapshot and the engine's config in
 * the clear. The stored credential reaches the provider through the broker at
 * the header the provider declares for it, never as one of these.
 */
export const CUSTOM_PROVIDER_METADATA_HEADERS = ["HTTP-Referer", "X-Title", "OpenAI-Organization", "OpenAI-Project"] as const

export function isCustomProviderMetadataHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return CUSTOM_PROVIDER_METADATA_HEADERS.some((allowed) => allowed.toLowerCase() === lower)
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const UNINJECTABLE_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "cookie", "proxy-authorization"])

/** Whether the broker can write a custom provider's stored key into this header: never a metadata header, never one the connection owns. */
export function isCustomProviderCredentialHeader(name: string): boolean {
  return HEADER_NAME.test(name) && !UNINJECTABLE_HEADERS.has(name.toLowerCase()) && !isCustomProviderMetadataHeader(name)
}
