/** Network policy entry kind. */
export type PolicyKind = "host" | "domain" | "group"

/** A single network policy entry. */
export interface NetworkPolicyEntry {
  id: string
  workspace_id?: string | null
  harness?: string | null
  target: string
  kind: PolicyKind
  constraints: PolicyConstraints
  created_at: number
  updated_at: number
}

/** Optional constraints on a policy entry. */
export interface PolicyConstraints {
  ports?: number[]
  paths?: string[]
  enabled?: boolean
  /** True if this entry was auto-created by the credential system. */
  auto?: boolean
}

/** Input for creating a policy entry. */
export interface PolicyWrite {
  workspace_id?: string
  harness?: string
  target: string
  kind: PolicyKind
  constraints?: PolicyConstraints
}

/**
 * Default sandbox allowlist — sourced from
 * https://github.com/daytonaio/sandbox-network-whitelist/blob/main/whitelist.yaml
 *
 * Grouped by category for UI display. Applied as the baseline for all providers.
 * Users add custom host/domain entries on top via the network policy API.
 */
export const DEFAULT_ALLOWLIST: Record<string, string[]> = {
  // Package managers
  npm: ["registry.npmjs.org", "registry.npmjs.com", "nodejs.org", "nodesource.com", "npm.pkg.github.com"],
  yarn: ["yarnpkg.com", "*.yarnpkg.com", "yarn.npmjs.org"],
  bun: ["bun.sh", "*.bun.sh"],
  pypi: ["pypi.org", "pypi.python.org", "files.pythonhosted.org", "bootstrap.pypa.io", "astral.sh"],
  rust: ["crates.io", "static.crates.io", "index.crates.io", "static.rust-lang.org", "rustup.rs"],
  golang: ["proxy.golang.org", "sum.golang.org", "index.golang.org", "go.dev", "*.golang.org"],
  composer: ["packagist.org", "*.packagist.org"],
  maven: ["repo1.maven.org", "repo.maven.apache.org"],
  // Git
  github: ["github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io"],
  gitlab: ["gitlab.com", "*.gitlab.com"],
  bitbucket: ["bitbucket.org"],
  azure_devops: ["dev.azure.com", "*.dev.azure.com", "login.microsoftonline.com"],
  // OS packages
  ubuntu: ["*.ubuntu.com"],
  debian: ["*.debian.org", "cdn-fastly.deb.debian.org"],
  // CDN
  cdn: ["fastly.com", "cloudflare.com", "gateway.ai.cloudflare.com", "*.workers.dev", "r2.cloudflarestorage.com", "*.r2.cloudflarestorage.com", "unpkg.com", "jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"],
  // Container registries
  docker: ["docker.io", "*.docker.io", "*.docker.com"],
  registries: ["mcr.microsoft.com", "registry.k8s.io", "gcr.io", "*.gcr.io", "*.pkg.dev", "quay.io", "public.ecr.aws", "*.ecr.aws"],
  // Cloud storage
  aws: ["*.us-east-1.amazonaws.com", "*.us-east-2.amazonaws.com", "*.us-west-1.amazonaws.com", "*.us-west-2.amazonaws.com", "*.eu-central-1.amazonaws.com", "*.eu-west-1.amazonaws.com"],
  gcs: ["storage.googleapis.com"],
  azure_blob: ["*.blob.core.windows.net"],
  // AI / LLM
  anthropic: ["*.anthropic.com", "claude.ai", "platform.claude.com"],
  openai: ["openai.com", "*.openai.com", "chatgpt.com", "*.openai.azure.com", "*.services.ai.azure.com"],
  google_ai: ["generativelanguage.googleapis.com", "gemini.google.com", "aistudio.google.com", "ai.google.dev", "models.dev"],
  huggingface: ["huggingface.co", "*.huggingface.co"],
  ai_services: ["api.perplexity.ai", "api.deepseek.com", "api.groq.com", "openrouter.ai", "api.fireworks.ai", "*.cursor.com", "*.cursor.sh", "ampcode.com", "*.ampcode.com", "ai-gateway.vercel.sh"],
  // Claxedo / OpenCode
  opencode: ["opencode.ai", "*.opencode.ai", "app.daytona.io"],
  // Dev platforms
  vercel: ["vercel.com", "*.vercel.com", "*.vercel.app"],
  supabase: ["supabase.com", "*.supabase.com", "supabase.co", "*.supabase.co"],
  convex: ["convex.dev", "*.convex.dev", "*.convex.cloud"],
  railway: ["railway.app", "*.railway.app"],
  // Observability
  sentry: ["sentry.io", "*.sentry.io", "sentry-cdn.com", "*.sentry-cdn.com"],
  posthog: ["posthog.com", "*.posthog.com"],
  langfuse: ["*.langfuse.com", "*.cloud.langfuse.com"],
  // Browser testing
  playwright: ["playwright.dev", "cdn.playwright.dev"],
}

/**
 * Extra hosts appended to the default allowlist via
 * CLAXEDO_NETWORK_ALLOWLIST_EXTRA (comma-separated). Lets self-hosted
 * deployments allow their own hosts without editing DEFAULT_ALLOWLIST.
 */
export function extraAllowlistHosts(env: Record<string, string | undefined> = process.env): string[] {
  return (env.CLAXEDO_NETWORK_ALLOWLIST_EXTRA ?? "").split(",").map((host) => host.trim()).filter(Boolean)
}

/** Flatten the default allowlist (plus env-configured extras) into a single array of hosts. */
export function flattenDefaultAllowlist(): string[] {
  return [...Object.values(DEFAULT_ALLOWLIST).flat(), ...extraAllowlistHosts()]
}

/** Required Claxedo control-plane endpoints — always allowed. */
export const CONTROL_PLANE_HOSTS = [
  "127.0.0.1",
  "localhost",
]

/**
 * Maps credential provider IDs to network group names.
 * When a credential is stored for a provider, the corresponding
 * group is auto-added to the network allowlist.
 */
export const PROVIDER_TO_GROUP: Record<string, string> = {
  "claude-acp": "anthropic",
  "claude-sdk": "anthropic",
  "codex-acp": "openai",
  "codex-app-server": "openai",
  "cursor-acp": "openai",
  "anthropic": "anthropic",
  "openai": "openai",
  "google": "google_ai",
  "daytona": "opencode",
  "modal": "opencode",
}
