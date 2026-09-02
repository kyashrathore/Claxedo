import {
  createHostedContributionPort,
  type HostedContributionInput,
  type HostedContributionPort,
} from "@/platform/account/hosted-contribution-port"
import type { AccountState } from "@/platform/account/account-port"
import type { ContentSurfaceContribution } from "../integrations/content-surface-contract"

/**
 * The single product-contribution registry.
 *
 * Two products compose this renderer. The unsigned desktop registers local
 * capabilities only; the hosted product adds WorkGraph, Documents, and the
 * rest of its surfaces. Before this seam existed the difference was a set of
 * runtime flags scattered across feature ports, which could hide a capability
 * but never remove it from the build.
 *
 * The distinction that makes this worth a module: `loadHosted` is a LOADER, not
 * a set. The caller hands over a function that dynamically imports the hosted
 * module, so the hosted implementations are absent from the local entry's
 * static graph rather than merely unregistered. That is the property the
 * emitted-artifact gate checks, and the reason a flag was never going to be
 * enough.
 *
 * ACTIVATION LIFECYCLE lives in `platform/account/hosted-contribution-port.ts`,
 * not here. This module knows what a content surface is; it cannot know whether
 * the window holds an account, because `platform/*` may not import `@/app/*`
 * and the account is a platform concern. So the mechanism — at most once, the
 * signed gate on both sides of the load, the cached bundle, ordered removal,
 * all-or-nothing duplicate refusal — is generic and lives down there, and this
 * module binds it to `ContentSurfaceContribution` and to the registry.
 *
 * Deliberately not a general plugin system. Anything beyond content surfaces
 * belongs in the contribution registry the surfaces already use.
 */

export type HostedContributionSet = {
  contentSurfaces: readonly ContentSurfaceContribution[]
}

export type HostedContributionLoader = () => Promise<HostedContributionSet>

/**
 * The one app-layer binding of the generic account-owned activation mechanism.
 *
 * Product and fixed-service policies may each need an independently fenced
 * activation, but they must not bind the platform mechanism themselves. This
 * keeps the contribution vocabulary and registry ownership in one module while
 * allowing WorkGraph and Documents to have separate lifecycles.
 */
export function createContentSurfaceActivation(
  input: HostedContributionInput<ContentSurfaceContribution>,
): HostedContributionPort {
  return createHostedContributionPort<ContentSurfaceContribution>(input)
}

/**
 * Content types the hosted set provides, as plain strings.
 *
 * Kept here rather than derived from `hostedContentSurfaces` on purpose:
 * reading them from the module would import it, which is the one thing the
 * local composition must not do. Restored-state pruning needs to know which
 * types a build can EVER render, and it has to know that synchronously, before
 * any activation has resolved.
 */
export const HOSTED_CONTENT_TYPES = [
  "page",
  "pages-index",
  "workgraph",
  "workspace-workgraph",
  "task-composer",
] as const

export type ProductContributionsInput = {
  local: readonly ContentSurfaceContribution[]
  register: (surface: ContentSurfaceContribution) => void
  unregister: (surface: ContentSurfaceContribution) => void
  /** Loads the hosted set. Absent from a composition that cannot host it. */
  loadHosted?: HostedContributionLoader
  /**
   * Whether this composition may hold hosted contributions at all.
   *
   * The build signal, not the account: a hosted build activates at boot and
   * serves unsigned windows too, and a local build must never register the
   * hosted set even if an account somehow reports signed. Unit 11 replaces this
   * with the account port's own signed state, at which point it and
   * `followAccount` become the same question.
   */
  hostedComposition: () => boolean
}

export type ProductContributions = {
  /** Content surfaces available before any account activation. */
  localContentSurfaces(): readonly ContentSurfaceContribution[]
  /**
   * Declare that this composition intends to activate the hosted set.
   *
   * Separate from `activateHosted` because activation is asynchronous and
   * restored-state pruning is not. A hosted build that pruned against
   * "registered right now" would delete every restored WorkGraph tab in the
   * window before the dynamic import resolves.
   */
  expectHosted(): void
  /** Whether hosted surfaces are expected, whether or not they have loaded. */
  hostedExpected(): boolean
  /** Every content type this composition can ever render. */
  availableContentTypes(): readonly string[]
  /** Whether the hosted set has been activated in this composition. */
  hostedActive(): boolean
  /** Load and register the hosted set, at most once. */
  activateHosted(): Promise<void>
  /**
   * Follow the account: activate while it is signed, remove on sign-OUT.
   *
   * Asymmetric on purpose, and this is the one policy decision in this module.
   *
   * A hosted BUILD composes hosted surfaces whether or not a window holds an
   * account — that is what `initClaxedo` does at boot, and the loopback E2E
   * lane depends on it (`core-workgraph.spec.ts` renders WorkGraph with no
   * account). So "not signed" cannot mean "remove"; it would empty the
   * composition of every window that has not signed in yet.
   *
   * Signing OUT carries no such ambiguity, and it is the defect this closes:
   * before it, hosted surfaces stayed registered until the page reloaded. A
   * window that has never held an account is left exactly as composed.
   *
   * Unit 11 makes activation itself account-driven, at which point `held`
   * disappears and this collapses to "signed ? activate : deactivate".
   */
  followAccount(account: AccountState): void
}

export function createProductContributions(input: ProductContributionsInput): ProductContributions {
  const local = input.local
  let expectsHosted = false
  let held = false

  const hosted = createContentSurfaceActivation({
    signedIn: input.hostedComposition,
    load: async () => {
      if (!input.loadHosted) {
        throw new Error("Hosted contribution loader is not configured for this product composition")
      }
      return (await input.loadHosted()).contentSurfaces
    },
    register: input.register,
    unregister: input.unregister,
    // The LOCAL ids, and only those. Everything else in the registry is either
    // this port's own set — which it tracks itself and removes on deactivation
    // — or a lease-bound agent contribution, whose ids are namespaced by lease
    // and are not the composition's to reserve.
    registeredIds: () => local.map((surface) => surface.id),
  })

  return {
    localContentSurfaces: () => local,
    expectHosted() {
      expectsHosted = true
    },
    hostedExpected: () => expectsHosted,
    availableContentTypes: () => [
      ...local.map((surface) => String(surface.surface)),
      ...(expectsHosted ? HOSTED_CONTENT_TYPES : []),
    ],
    hostedActive: () => hosted.active(),
    activateHosted() {
      expectsHosted = true
      return hosted.activate()
    },
    followAccount(account) {
      if (account.status === "signed") {
        held = true
        void hosted.activate().catch(() => {})
        return
      }
      if (!held) return
      held = false
      hosted.deactivate()
    },
  }
}

/**
 * The composition every entry shares.
 *
 * Bound by `configureProductContributions` rather than constructed with a
 * static import of the surface list. This module is the CONTRACT; importing the
 * concrete local surfaces here would pull the entire renderer chain into
 * anything that wants to read `HOSTED_CONTENT_TYPES`, which is the opposite of
 * what a composition contract is for.
 *
 * Same `configureX(...)` port shape the runtime and feature ports already use.
 */
let instance: ProductContributions | undefined

export function configureProductContributions(input: ProductContributionsInput) {
  instance = createProductContributions(input)
  return instance
}

export function productContributions(): ProductContributions {
  if (!instance) {
    throw new Error("Product contributions are not configured; call configureProductContributions() from the app entry")
  }
  return instance
}
