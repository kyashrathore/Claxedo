import type { OnboardingState, OnboardingSurface } from "./state"

export type OnboardingStepId = "destination" | "ai" | "remote-access"

/**
 * What a step's CTA does — a separate vocabulary from the step ids above, and
 * deliberately so: several steps resolve to the same shell action, and the
 * project step's action even varies by surface (`open-project` on desktop,
 * `pick-repository` on web). A verb here is not a duplicate of the noun above.
 */
export type OnboardingStepAction =
  | "choose-destination"
  | "open-project"
  | "pick-repository"
  | "connect-ai"
  | "enable-remote-access"

export type OnboardingStepCta = {
  label: string
  action: OnboardingStepAction
}

export type OnboardingVerification = "destination" | "credential" | "remote-access"

export type OnboardingStepDefinition = {
  id: OnboardingStepId
  title: string
  titleFor?: (state: OnboardingState) => string
  /**
   * Whether the step belongs in this run at all. A step that does not apply is
   * absent from the rail and the count — never rendered as a disabled row.
   */
  appliesTo: (surface: OnboardingSurface, state: OnboardingState) => boolean
  isDone: (state: OnboardingState) => boolean
  isLocked: (state: OnboardingState) => boolean
  lockReason: (state: OnboardingState) => string | undefined
  cta: (state: OnboardingState) => OnboardingStepCta
  /** One-line goal statement, shown as the screen's lede. */
  education: string
  /** Required steps have no skip affordance; optional ones state the consequence. */
  optional?: boolean
  verify?: OnboardingVerification
}

export type OnboardingStepState = {
  id: OnboardingStepId
  definition: OnboardingStepDefinition
  title: string
  applies: boolean
  done: boolean
  locked: boolean
  lockReason: string | undefined
  cta: OnboardingStepCta
  education: string
  optional: boolean
  verify: OnboardingVerification | undefined
}

const appliesEverywhere = () => true

function aiLockReason(state: OnboardingState) {
  if (state.hasUsableCredential) return
  if (state.destination === undefined) return "Answer the first question to continue."
}

/**
 * The first step is settled once the answer has everything it needs to run.
 *
 * Each branch owes something different, which is why there is no shared project
 * step after this one. Yes owes a provider key to pay for the sandbox and a code
 * host to clone from — the connected repository IS that branch's project, so
 * also demanding a local folder would be a gate the cloud never reads. No owes a
 * project folder, because a session here needs somewhere to work; that is why
 * the picker lives in this step's no-branch rather than standing on its own.
 *
 * A bare answer is never enough either way: it would let setup hand the user
 * on to a session it cannot start.
 */
function destinationSettled(state: OnboardingState): boolean {
  if (state.destination === undefined) return false
  if (!state.wantsCloud) return state.hasProject
  return state.sandboxProviderConfigured && state.codeHostConnected === true
}

/**
 * Three questions, each answerable with what the last one produced.
 *
 * The first asks whether to add cloud sessions, and collects what that answer
 * needs in place — a provider key and a repository to clone if yes, the project
 * folder if no. The second connects the AI, offering the methods that work
 * where the agents will actually run. The third offers to reach this machine
 * from elsewhere, and is skippable because it is the one step that needs an
 * account.
 */
export const onboardingSteps: readonly OnboardingStepDefinition[] = [
  {
    id: "destination",
    title: "Do you want to run cloud sessions too?",
    appliesTo: appliesEverywhere,
    isDone: destinationSettled,
    isLocked: () => false,
    lockReason: () => undefined,
    cta: () => ({ label: "Choose", action: "choose-destination" }),
    education: "Sessions run on this machine. Add the cloud and they keep running without it.",
    verify: "destination",
  },
  {
    id: "ai",
    title: "Connect your AI",
    appliesTo: appliesEverywhere,
    isDone: (state) => state.hasUsableCredential,
    // Which methods this step offers — and whether it stores anything at all —
    // is decided by the first answer, so it cannot render before that exists.
    isLocked: (state) => aiLockReason(state) !== undefined,
    lockReason: aiLockReason,
    cta: (state) => ({
      label: state.hasCredentialElsewhere && !state.hasUsableCredential ? "Connect on this machine" : "Connect AI",
      action: "connect-ai",
    }),
    education: "Once this is connected, agents can start working.",
    verify: "credential",
  },
  {
    id: "remote-access",
    title: "Do you want to access this machine remotely?",
    // The only step that needs an account, which is why it is skippable: setup
    // must finish without one. Desktop only — there is no "this machine" to
    // reach when Claxedo is already the remote one.
    appliesTo: (surface) => surface === "desktop",
    isDone: (state) => state.remoteAccessEnabled,
    isLocked: (state) => state.remoteAccessAvailable === false && !state.remoteAccessEnabled,
    lockReason: (state) => state.remoteAccessAvailable === false ? state.remoteAccessLockedReason : undefined,
    cta: () => ({ label: "Set up remote access", action: "enable-remote-access" }),
    education: "Watch work and reply from your phone while your laptop keeps running it.",
    optional: true,
    verify: "remote-access",
  },
]

export function onboardingStepStates(state: OnboardingState): readonly OnboardingStepState[] {
  return onboardingSteps.map((definition) => ({
    id: definition.id,
    definition,
    title: definition.titleFor?.(state) ?? definition.title,
    applies: definition.appliesTo(state.surface, state),
    done: definition.isDone(state),
    locked: definition.isLocked(state),
    lockReason: definition.lockReason(state),
    cta: definition.cta(state),
    education: definition.education,
    optional: definition.optional === true,
    verify: definition.verify,
  }))
}
