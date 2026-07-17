import type { OnboardingState, OnboardingSurface } from "./state"

export type OnboardingStepId = "project" | "ai" | "compute" | "remote-access"

export type OnboardingStepAction =
  | "open-project"
  | "pick-repository"
  | "connect-ai"
  | "sign-in"
  | "add-compute"
  | "enable-remote-access"
  | "open-phone-access"

export type OnboardingStepCta = {
  label: string
  action: OnboardingStepAction
}

export type OnboardingVerification = "repository" | "credential" | "cloud-turn" | "second-device"

export type OnboardingStepDefinition = {
  id: OnboardingStepId
  title: string
  titleFor?: (state: OnboardingState) => string
  appliesTo: (surface: OnboardingSurface) => boolean
  isDone: (state: OnboardingState) => boolean
  isLocked: (state: OnboardingState) => boolean
  lockReason: (state: OnboardingState) => string | undefined
  cta: (state: OnboardingState) => OnboardingStepCta
  education: string
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
  verify: OnboardingVerification | undefined
}

const appliesEverywhere = (_surface: OnboardingSurface) => true

export const onboardingSteps: readonly OnboardingStepDefinition[] = [
  {
    id: "project",
    title: "Open a project",
    titleFor: (state) => state.surface === "desktop" ? "Open a project" : "Pick a repository",
    appliesTo: appliesEverywhere,
    isDone: (state) => state.hasProject,
    isLocked: () => false,
    lockReason: () => undefined,
    cta: (state) => state.surface === "desktop"
      ? { label: "Open a project", action: "open-project" }
      : { label: "Pick a repository", action: "pick-repository" },
    education: "Choose the codebase where your first task will run.",
    verify: "repository",
  },
  {
    id: "ai",
    title: "Connect your AI",
    appliesTo: appliesEverywhere,
    isDone: (state) => state.hasUsableCredential,
    isLocked: (state) => state.surface !== "desktop" && !state.hasProject && !state.hasUsableCredential,
    lockReason: (state) => state.surface !== "desktop" && !state.hasProject && !state.hasUsableCredential
      ? "Open a project first."
      : undefined,
    cta: (state) => ({
      label: state.hasCredentialElsewhere && !state.hasUsableCredential ? "Connect on this machine" : "Connect AI",
      action: "connect-ai",
    }),
    education: "A verified credential unlocks a runnable agent harness.",
    verify: "credential",
  },
  {
    id: "compute",
    title: "Add compute",
    appliesTo: appliesEverywhere,
    isDone: (state) => state.hasFirstCloudTurn,
    isLocked: (state) => {
      if (state.hasFirstCloudTurn) return false
      if (state.surface === "desktop") return !state.hasFirstTurn
      return !state.hasUsableCredential
    },
    lockReason: (state) => {
      if (state.hasFirstCloudTurn) return undefined
      if (state.surface === "desktop") {
        return state.hasFirstTurn ? undefined : "Complete your first task to unlock cloud compute."
      }
      return state.hasUsableCredential ? undefined : "Connect working AI credentials first."
    },
    cta: (state) => state.surface === "desktop" && !state.hostedSignedIn
      ? { label: "Sign in to add compute", action: "sign-in" }
      : { label: "Add compute", action: "add-compute" },
    education: "Cloud compute keeps agent work running away from this device.",
    verify: "cloud-turn",
  },
  {
    id: "remote-access",
    title: "Access remotely",
    appliesTo: appliesEverywhere,
    isDone: (state) => state.secondDeviceOpen,
    isLocked: (state) => {
      if (state.secondDeviceOpen) return false
      if (state.remoteAccessAvailable === false) return true
      if (state.surface === "desktop") return !state.hasFirstTurn
      return !state.hasFirstCloudTurn
    },
    lockReason: (state) => {
      if (state.secondDeviceOpen) return undefined
      if (state.remoteAccessAvailable === false) {
        return state.remoteAccessLockedReason ?? "Remote access is not available yet."
      }
      if (state.surface === "desktop") {
        return state.hasFirstTurn ? undefined : "Complete your first task to unlock remote access."
      }
      return state.hasFirstCloudTurn ? undefined : "Run your first cloud task to unlock remote access."
    },
    cta: (state) => state.surface === "desktop" && !state.remoteAccessEnabled
      ? { label: "Enable remote access", action: "enable-remote-access" }
      : { label: "Open phone access", action: "open-phone-access" },
    education: "Open a running workspace from a second signed-in device.",
    verify: "second-device",
  },
]

export function onboardingStepStates(state: OnboardingState): readonly OnboardingStepState[] {
  return onboardingSteps.map((definition) => ({
    id: definition.id,
    definition,
    title: definition.titleFor?.(state) ?? definition.title,
    applies: definition.appliesTo(state.surface),
    done: definition.isDone(state),
    locked: definition.isLocked(state),
    lockReason: definition.lockReason(state),
    cta: definition.cta(state),
    education: definition.education,
    verify: definition.verify,
  }))
}
