import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

const en = {
  "onboarding.steps": "Setup steps",
  "onboarding.step.project": "Project",
  "onboarding.step.ai": "AI",
  "onboarding.step.execution": "Where it runs",
  "onboarding.project.headline": "Start with a project",
  "onboarding.project.lede.local": "Point Claxedo at a folder on this machine, or at a repository to clone. Where the work runs is a later question.",
  "onboarding.project.lede.hosted": "Point Claxedo at a repository to clone. Where the work runs is a later question.",
  "onboarding.ai.headline": "Connect an AI",
  "onboarding.ai.lede.local": "The agent runs on a login of yours. Anything found here can be changed later in Settings → Models.",
  "onboarding.ai.lede.hosted": "Cloud sandboxes here run Pi on a key of yours, stored on this deployment and handed to every sandbox you start. It can be changed later in Settings → Models.",
  "onboarding.execution.headline": "Where it runs",
  "onboarding.execution.lede.local": "Work runs on this machine unless you say otherwise.",
  "onboarding.execution.lede.hosted": "Work runs in a cloud sandbox this deployment provides, or on a machine you connect.",
  "onboarding.continue": "Continue",
  "onboarding.back": "Back",
  "onboarding.skip": "Skip for now",
  "onboarding.next": "Next",
  "onboarding.finish.project": "Open project",
  "onboarding.finish.workspace": "Create workspace",
  "onboarding.finishing.project": "Creating project…",
  "onboarding.finishing.workspace": "Creating workspace…",
  "onboarding.open.project": "Open created project",
  "onboarding.open.workspace": "Open created workspace",
  "onboarding.opening": "Opening…",
  "onboarding.reason.ai.local": "Connect a login above, or skip and connect at your first message.",
  "onboarding.reason.ai.hosted": "Save a key for one provider to continue.",
  "onboarding.reason.execution.signIn": "Sign in to a control plane to create a cloud sandbox.",
  "onboarding.reason.execution.folder": "Choose a repository instead of a local folder to create a cloud sandbox.",
  "onboarding.reason.execution.machine": "Pick the cloud sandbox to finish; a connected machine cannot take this repository yet.",
  "onboarding.failed.noPlacement": "{{project}} has no folder here to open.",
  "onboarding.failed.open": "Created successfully, but could not open it: {{error}}",
  "onboarding.ai.logins": "Logins on this machine",
  "onboarding.ai.scanning": "Scanning this machine for logins…",
  "onboarding.ai.catalog": "Or connect a provider for",
  "onboarding.execution.label": "Where work runs",
  "onboarding.execution.local.title": "Just this machine",
  "onboarding.execution.local.detail": "Sessions run on this computer, in the project's folder.",
  "onboarding.execution.cloud.title": "A cloud sandbox",
  "onboarding.execution.cloud.detail": "Sessions run in a sandbox the connected control plane provides.",
  "onboarding.execution.connected.title": "Another machine",
  "onboarding.execution.connected.detail": "A computer you connect with the Claxedo CLI serves the work.",
  "onboarding.execution.cloud.note": "The connected control plane provides the sandbox; there is nothing to configure here.",
  "onboarding.execution.machine.intro": "Connecting a machine takes two commands: one here, one on that machine.",
  "onboarding.execution.machine.invite": "On a signed-in machine",
  "onboarding.execution.machine.connect": "On the machine being added",
  "onboarding.execution.machine.local": "Machines you connect appear in Settings → Machines. This project opens on this computer for now.",
  "onboarding.execution.machine.hosted": "Nothing can send this repository to a machine you connect yet, so pick the cloud sandbox to start; a connected machine's own folders appear as projects once it serves them.",
}

export type OnboardingKey = keyof typeof en

const onboardingDictionary = {
  en,
} satisfies Translations<OnboardingKey>

export type OnboardingText = DomainTranslate<OnboardingKey>

export const useOnboardingText = (): OnboardingText => useTranslator(onboardingDictionary)
