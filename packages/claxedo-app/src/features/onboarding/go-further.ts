import type { OnboardingSurface } from "./state"

export type OnboardingGoFurtherCardId = "harnesses" | "self-host"

export type OnboardingGoFurtherCard = {
  id: OnboardingGoFurtherCardId
  title: string
  education: string
  action: string
  appliesTo: (surface: OnboardingSurface) => boolean
}

/**
 * What to do once setup is finished. Remote access is not here: it is the last
 * setup step, offered and skippable in the flow rather than waiting on a card.
 */
export const onboardingGoFurtherCards: readonly OnboardingGoFurtherCard[] = [
  {
    id: "harnesses",
    title: "Check Claude Code, Codex, and Cursor",
    // Named rather than "any harness": the check covers exactly these three,
    // and a card that promised the full catalog would send the user looking for
    // rows that are not there.
    education: "See which of them are ready to run on this machine.",
    action: "Check my logins",
    appliesTo: () => true,
  },
  {
    id: "self-host",
    title: "Deploy on your own infrastructure",
    education: "Run the same Claxedo experience on a box you control.",
    action: "Read deployment guide",
    appliesTo: (surface) => surface !== "self-host",
  },
]
