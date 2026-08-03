/**
 * The harness → provider-catalog contract, app side.
 *
 * This is a deliberate MIRROR of
 * `packages/claxedo-server/src/agent-config/harness-provider-contract.ts`. The two
 * packages share no import path, so the sets are re-stated here and
 * `harness-provider-contract.vitest.tsx` renders the real `ProviderList`
 * against fixtures built from them. The server copy is asserted against the
 * real provider route, so the pair together pins server output to UI input.
 * Change one, change both.
 */

/**
 * The five harness-BINDING provider ids served for every non-pi, non-opencode
 * harness. Derived server-side from `localProviderCatalog`'s credential-env map,
 * which is why `cursor-sdk` (no binding) is absent from this list even though it
 * is a selectable harness.
 */
export const HARNESS_BINDING_PROVIDER_IDS = [
  "claude-acp",
  "claude-sdk",
  "codex-acp",
  "codex-app-server",
  "cursor-acp",
] as const

/** Pi serves only its launch providers. */
export const PI_PROVIDER_IDS = ["anthropic", "openai", "openai-codex"] as const

/** Provider ids the models.dev-backed opencode catalog must carry. The live
 * catalog has ~179 entries and moves with models.dev, so only these are pinned. */
export const OPENCODE_SAMPLE_PROVIDER_IDS = ["anthropic", "openai", "google", "opencode"] as const

/** Harness ids that resolve to the five harness-binding providers. */
export const HARNESS_BINDING_HARNESS_IDS = [
  "claude-acp",
  "codex-acp",
  "cursor-acp",
  "claude-sdk",
  "codex-app-server",
  "cursor-sdk",
] as const

/** The provider-id set the UI must render for a given harness. `undefined`
 * (no harness context) gets the full models.dev catalog, same as opencode. */
export function contractProviderIds(harness: string | undefined): readonly string[] {
  if (harness === "pi") return PI_PROVIDER_IDS
  if (harness === undefined || harness === "opencode") return OPENCODE_SAMPLE_PROVIDER_IDS
  return HARNESS_BINDING_PROVIDER_IDS
}

/** A provider-route-shaped response body for the given provider ids, as the
 * app's `normalizeProviderList` expects to receive it. */
export function providerCatalogFixture(providerIds: readonly string[]) {
  return {
    all: providerIds.map((id) => ({
      id,
      name: id,
      env: [] as string[],
      models: { [`${id}-model`]: { id: `${id}-model`, name: `${id} model` } },
    })),
    connected: [] as string[],
    default: {} as Record<string, string>,
  }
}
