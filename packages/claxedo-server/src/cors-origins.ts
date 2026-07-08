// Deployment-configured HTTPS origin suffixes (CLAXEDO_ALLOWED_ORIGIN_SUFFIXES,
// comma-separated domain suffixes, default "claxedo.com,opencode.ai"). Each
// suffix `example.com` allows `https://example.com` plus any
// `https://<sub>.example.com` subdomain via the same anchored regex that used
// to be hardcoded per call site, so self-hosted deployments can point CORS at
// their own domain without editing shared code.
export const DEFAULT_ALLOWED_ORIGIN_SUFFIXES = "claxedo.com,opencode.ai"

export function allowedOriginPatterns(raw: string | undefined): RegExp[] {
  const suffixes = (raw?.trim() || DEFAULT_ALLOWED_ORIGIN_SUFFIXES)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return suffixes.map((suffix) => new RegExp(`^https:\\/\\/([a-z0-9-]+\\.)*${suffix.replaceAll(".", "\\.")}$`))
}
