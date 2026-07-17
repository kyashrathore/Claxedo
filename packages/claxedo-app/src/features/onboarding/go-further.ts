import type { OnboardingSurface } from "./state"

export type OnboardingGoFurtherCardId = "workgraph" | "harnesses" | "self-host"

export type OnboardingGoFurtherCard = {
  id: OnboardingGoFurtherCardId
  title: string
  education: string
  action: string
  appliesTo: (surface: OnboardingSurface) => boolean
}

export const onboardingGoFurtherCards: readonly OnboardingGoFurtherCard[] = [
  {
    id: "workgraph",
    title: "Organize work with WorkGraph",
    education: "Turn a large outcome into streams agents can execute and verify.",
    action: "Open WorkGraph",
    appliesTo: () => true,
  },
  {
    id: "harnesses",
    title: "Use any runnable harness",
    education: "See which agent harnesses your verified AI connections unlock.",
    action: "View harnesses",
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
