import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

const en = {
  "onboarding.steps": "Setup steps",
  "onboarding.step.project": "Project",
  "onboarding.step.ai": "AI",
  "onboarding.step.placement": "Where it runs",
  "onboarding.project.headline": "Start with a project",
  "onboarding.project.lede.machine": "Point Claxedo at a folder on this machine, or at a repository. Where the work runs is a later question.",
  "onboarding.project.lede.hosted": "Point Claxedo at a repository. Where the work runs is a later question.",
  "onboarding.ai.headline": "Connect an AI",
  "onboarding.ai.lede": "The agent runs on a login of yours. Anything chosen here can be changed later in Settings.",
  "onboarding.placement.headline": "Where it runs",
  "onboarding.placement.lede.machine": "Work runs on this machine unless you say otherwise.",
  "onboarding.placement.lede.hosted": "Work runs in a cloud workspace, or on a machine you connect.",
}

export type OnboardingKey = keyof typeof en

export const dictionary = {
  en,
} satisfies Translations<OnboardingKey>

export type OnboardingText = DomainTranslate<OnboardingKey>

export const useOnboardingText = (): OnboardingText => useTranslator(dictionary)
