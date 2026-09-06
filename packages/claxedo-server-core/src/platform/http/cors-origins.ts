// Deployment-configured HTTPS origin suffixes (CLAXEDO_ALLOWED_ORIGIN_SUFFIXES,
// comma-separated domain suffixes, default "claxedo.com"). Each suffix
// `example.com` allows `https://example.com` plus any
// `https://<sub>.example.com` subdomain via one shared anchored regex, so
// self-hosted deployments can point CORS at their own domain without editing
// shared code.
//
// Claxedo's own domain only — adding upstream's domain here would treat
// upstream's hosted app as a first-party origin.
export const DEFAULT_ALLOWED_ORIGIN_SUFFIXES = "claxedo.com"

export function allowedOriginPatterns(raw: string | undefined): RegExp[] {
  const suffixes = (raw?.trim() || DEFAULT_ALLOWED_ORIGIN_SUFFIXES)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return suffixes.map((suffix) =>
    new RegExp(`^https:\\/\\/([a-z0-9-]+\\.)*${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
}
