// DEV-only harness that forces the top-level ErrorBoundary fallback
// (`ErrorPage`) to render for a chosen InitError variant, so e2e can assert the
// formatted error chain + Restart affordance without a real init crash. Mirrors
// `dialog-matrix-harness.tsx`: mounted only behind `import.meta.env.DEV` in
// app.tsx, addressed by a `?variant=` query param.
import { createMemo } from "solid-js"
import { useLocation } from "@solidjs/router"
import { ErrorPage } from "./error"
import type { InitError } from "./error-format"

type HarnessError = InitError | Error | string

const VARIANTS: Record<string, () => HarnessError> = {
  MCPFailed: () => ({ name: "MCPFailed", data: { name: "github" } }),
  ProviderAuthError: () => ({
    name: "ProviderAuthError",
    data: { providerID: "anthropic", message: "401 Unauthorized" },
  }),
  APIError: () => ({
    name: "APIError",
    data: { message: "Upstream request failed", statusCode: 502, isRetryable: true },
  }),
  ProviderModelNotFoundError: () => ({
    name: "ProviderModelNotFoundError",
    data: { providerID: "anthropic", modelID: "claude-x", suggestions: ["claude-a", "claude-b"] },
  }),
  ProviderInitError: () => ({ name: "ProviderInitError", data: { providerID: "openai" } }),
  ConfigJsonError: () => ({ name: "ConfigJsonError", data: { path: "/config.json", message: "Unexpected token" } }),
  ConfigDirectoryTypoError: () => ({
    name: "ConfigDirectoryTypoError",
    data: { path: "/root", dir: ".opencodee", suggestion: ".opencode" },
  }),
  ConfigFrontmatterError: () => ({
    name: "ConfigFrontmatterError",
    data: { path: "/agents/build.md", message: "Invalid YAML" },
  }),
  ConfigInvalidError: () => ({
    name: "ConfigInvalidError",
    data: { path: "/config.json", message: "Schema mismatch", issues: [{ message: "expected string", path: ["model"] }] },
  }),
  UnknownError: () => ({ name: "UnknownError", data: { message: "Something went wrong" } }),
  causeChain: () => {
    const cause = new Error("socket hang up")
    const wrapper = new Error("Failed to reach provider", { cause })
    return wrapper
  },
  string: () => "A plain string failure surfaced to the crash page.",
}

const DEFAULT_VARIANT = "UnknownError"

export default function ErrorPageHarness() {
  const location = useLocation()
  const error = createMemo<HarnessError>(() => {
    const variant = new URLSearchParams(location.search).get("variant") ?? DEFAULT_VARIANT
    return (VARIANTS[variant] ?? VARIANTS[DEFAULT_VARIANT])()
  })

  return (
    <div data-testid="error-page-harness" data-error-variant={new URLSearchParams(location.search).get("variant") ?? DEFAULT_VARIANT}>
      <ErrorPage error={error()} />
    </div>
  )
}

/** The variant keys this harness understands, exported for spec assertions. */
export const ERROR_PAGE_HARNESS_VARIANTS = Object.keys(VARIANTS)
