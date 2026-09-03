/**
 * How a composition turns a hosted contribution set ON and, crucially, OFF.
 *
 * `app/composition/product-contributions.ts` owned activation and had no way
 * back: once the hosted set was registered it stayed registered for the life of
 * the window, so signing out left Documents and every other hosted
 * surface installed until a reload. The missing half is not a line in that
 * module — it is a lifecycle, and a lifecycle needs an owner.
 *
 * It lives HERE, next to the account port, for one reason: the decision is
 * "does this window hold a signed account", and `platform/*` may not import
 * `@/app/*` (`architecture/ownership.ts`). A hosted-contribution lifecycle
 * declared in app composition could see the account; one declared in platform
 * can be handed the account and stays reusable. The call site keeps the
 * contribution vocabulary.
 *
 * Which is why this is GENERIC. `ContentSurfaceContribution` is an app type and
 * cannot be named from here; re-declaring its shape across the boundary would
 * create two contracts that drift. `T extends { id: string }` is the entire
 * property this module needs — ids are what it validates and what it removes
 * by — and `app/composition/product-contributions.ts` binds `T` at the one
 * place that owns both sides.
 *
 * Import-free, the way `account-port.ts` is: the contract can be read on its
 * own, and the import graph sees it as the mechanism it is.
 */

export type HostedContributionErrorCode =
  /** Asked to activate with no signed account — before, or after, the load. */
  | "account_not_signed"
  /** Deactivated while the load was in flight, so the result was dropped. */
  | "activation_abandoned"
  /** A hosted contribution claims an id the composition already registered. */
  | "shadows_registered_contribution"
  /** Two contributions inside one hosted set claim the same id. */
  | "duplicate_contribution_id"

/**
 * Distinct codes because the two duplicate cases have different owners.
 *
 * `shadows_registered_contribution` means the hosted set collided with what
 * this build already has — a composition conflict. `duplicate_contribution_id`
 * means the hosted set is internally inconsistent — a bug inside the loaded
 * bundle. A single code would send every reader to the wrong half.
 */
export class HostedContributionError extends Error {
  constructor(
    readonly code: HostedContributionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "HostedContributionError"
  }
}

export type HostedContributionPort = {
  /** Whether the hosted set is registered, or is being registered right now. */
  active(): boolean
  /**
   * Load and register the hosted set, at most once.
   *
   * Concurrent callers share one in-flight promise: the signed-in transition
   * and a route that needs a hosted surface can fire in either order, and
   * registering the same contributions twice is an error rather than a no-op.
   */
  activate(): Promise<void>
  /**
   * Unregister everything this port registered, and allow activating again.
   *
   * Reverse registration order, so a contribution that was installed on top of
   * another comes off first. Idempotent: deactivating an inactive port removes
   * nothing.
   */
  deactivate(): void
}

export type HostedContributionInput<T extends { id: string }> = {
  /**
   * Whether this window holds a signed account.
   *
   * A boolean, not an `AccountState`: only that one bit matters here, and the
   * composition is where it is decided. The account port lives behind a Solid
   * context, which a plain module in `platform/*` cannot read — so the answer
   * is handed in, and only the caller has to know how it was reached.
   *
   * A function, not a value, and read on every check rather than snapshotted —
   * the same reason `AccountPort.state` is a function. It is read twice per
   * activation: once before the load starts, and once after it resolves.
   */
  signedIn: () => boolean
  /** Loads the hosted set. The dynamic import lives at the call site. */
  load: () => Promise<readonly T[]>
  register: (contribution: T) => void
  unregister: (contribution: T) => void
  /** Ids the composition has already registered, read at validation time. */
  registeredIds: () => Iterable<string>
}

export function createHostedContributionPort<T extends { id: string }>(
  input: HostedContributionInput<T>,
): HostedContributionPort {
  /**
   * The loaded bundle, kept ACROSS deactivation.
   *
   * Sign-out → sign-in in one window must not re-run the loader: the chunk is
   * already in memory and re-importing it buys nothing. Only a load that FAILED
   * leaves this unset, which is what makes a failed activation retryable.
   */
  let bundle: readonly T[] | undefined
  let activation: Promise<void> | undefined
  let installed: readonly T[] = []
  /**
   * Bumped by every `deactivate()`.
   *
   * An activation that resolves after its generation ended must not register.
   * The account re-check below catches the sign-out case; this catches the
   * caller that deactivated for any other reason while a load was in flight.
   */
  let generation = 0

  return {
    active: () => activation !== undefined,
    activate() {
      // Checked and assigned with no await in between, which is what makes
      // "at most once" hold: this function is synchronous and returns the
      // promise, so a second caller cannot arrive mid-assignment. An `if`
      // inside an `async` function would have exactly that bug.
      if (activation) return activation
      if (!input.signedIn()) {
        return Promise.reject(
          new HostedContributionError("account_not_signed", "Hosted contributions require a signed account"),
        )
      }

      const startedIn = generation
      const attempt = (async () => {
        const contributions = bundle ?? (bundle = await input.load())

        // Re-checked AFTER the load. A dynamic import takes a network round
        // trip on a cold cache; signing out inside that window and registering
        // anyway would install hosted surfaces into a signed-out app, which is
        // the failure the account gate exists to prevent.
        if (generation !== startedIn) {
          throw new HostedContributionError(
            "activation_abandoned",
            "Hosted contributions were deactivated while loading",
          )
        }
        if (!input.signedIn()) {
          throw new HostedContributionError(
            "account_not_signed",
            "The account signed out while hosted contributions were loading",
          )
        }

        // Validated in full before ANY registration. A partial registration
        // would leave a surface installed that `deactivate()` does not know
        // about, so there would be no way to remove it.
        const registered = new Set(input.registeredIds())
        const claimed = new Set<string>()
        for (const contribution of contributions) {
          if (registered.has(contribution.id)) {
            throw new HostedContributionError(
              "shadows_registered_contribution",
              `Hosted contribution "${contribution.id}" is already registered; it would shadow the existing contribution`,
            )
          }
          if (claimed.has(contribution.id)) {
            throw new HostedContributionError(
              "duplicate_contribution_id",
              `Hosted contribution "${contribution.id}" appears twice in one hosted set`,
            )
          }
          claimed.add(contribution.id)
        }

        for (const contribution of contributions) input.register(contribution)
        installed = contributions
      })()

      // Cached only while it is pending or fulfilled. Keeping a REJECTED
      // promise is how one transient chunk-load failure used to disable hosted
      // mode for the life of the window, with no way back short of a reload.
      activation = attempt
      attempt.catch(() => {
        if (activation === attempt) activation = undefined
      })
      return attempt
    },
    deactivate() {
      generation += 1
      activation = undefined
      const removing = installed
      installed = []
      for (let index = removing.length - 1; index >= 0; index -= 1) {
        input.unregister(removing[index]!)
      }
    },
  }
}
