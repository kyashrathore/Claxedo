/**
 * The harness → provider-catalog contract.
 *
 * `GET /provider?harness=<id>` answers with a DIFFERENT catalog per harness,
 * and until now nothing pinned which. The shapes below are derived from
 * `opencode-compat-provider-config.ts` (`providerBody` → `piProviderCatalog` /
 * `localProviderCatalog` / the engine catalog) and are asserted against the
 * real route in `harness-provider-contract.test.ts`.
 *
 * The app side has a mirror of this file at
 * `packages/claxedo-app/src/app/dialogs/test-support/harness-provider-contract.ts` — the two
 * packages have no shared import path, so the app copy re-states these sets and
 * a test there pins that they stay identical. Change one, change both.
 */

/** Every harness id the app can select. Mirrors `HARNESS_IDS` in the app's
 * `platform/identity/session-ref.ts`. */
export const HARNESS_IDS = [
  "claude-sdk",
  "codex-app-server",
  "cursor-sdk",
  "opencode",
  "pi",
] as const

export type ContractHarnessId = (typeof HARNESS_IDS)[number]

/**
 * The native harness-BINDING provider ids. `localProviderCatalog` derives this
 * list from the keys of its `envKeys` map, so it is the set of harnesses that
 * carry a credential slot — NOT the set of selectable harnesses.
 */
export const HARNESS_BINDING_PROVIDER_IDS = [
  "claude-sdk",
  "codex-app-server",
  "cursor-sdk",
] as const

/** `piProviderCatalog` filters the model catalog to `PI_LAUNCH_PROVIDERS`. */
export const PI_PROVIDER_IDS = ["anthropic", "openai", "openai-codex"] as const

/**
 * Provider ids the models.dev-backed opencode catalog must carry. The full
 * catalog has ~179 entries and its content moves with models.dev, so the
 * contract pins structural invariants rather than an exact list.
 */
export const OPENCODE_REQUIRED_PROVIDER_IDS = ["anthropic", "openai", "google", "opencode"] as const

/** The opencode catalog is the models.dev one, so it must be much larger than
 * the five-entry harness list — this is what distinguishes "served the real
 * catalog" from "fell back to the harness bindings". */
export const OPENCODE_MIN_PROVIDER_COUNT = 50

export type HarnessCatalogContract =
  | { readonly kind: "exact"; readonly providerIds: readonly string[] }
  | {
      readonly kind: "models-dev"
      readonly requiredProviderIds: readonly string[]
      readonly minProviderCount: number
      /** Ids that must NOT appear: the harness-binding ids are a different
       * namespace, and their presence means the fallback catalog was served. */
      readonly forbiddenProviderIds: readonly string[]
    }

const harnessBindingContract: HarnessCatalogContract = {
  kind: "exact",
  providerIds: HARNESS_BINDING_PROVIDER_IDS,
}

/**
 * What `/provider?harness=<id>` serves, per harness.
 *
 * Operator-defined ACP connections are discovered dynamically and are not
 * part of this finite built-in contract.
 */
export const HARNESS_PROVIDER_CONTRACT: Record<ContractHarnessId, HarnessCatalogContract> = {
  "claude-sdk": harnessBindingContract,
  "codex-app-server": harnessBindingContract,
  "cursor-sdk": harnessBindingContract,
  pi: { kind: "exact", providerIds: PI_PROVIDER_IDS },
  opencode: {
    kind: "models-dev",
    requiredProviderIds: OPENCODE_REQUIRED_PROVIDER_IDS,
    minProviderCount: OPENCODE_MIN_PROVIDER_COUNT,
    forbiddenProviderIds: HARNESS_BINDING_PROVIDER_IDS,
  },
}

/** An absent `?harness=` means "no preference" and resolves to the CONFIGURED
 * default harness, which is `opencode` unless config says otherwise. */
export const DEFAULT_HARNESS_ID: ContractHarnessId = "opencode"
