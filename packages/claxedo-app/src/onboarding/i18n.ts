import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

const en = {
  "onboarding.steps": "Setup steps",
  "onboarding.step.project": "Project",
  "onboarding.step.ai": "AI",
  "onboarding.step.execution": "Where it runs",
  "onboarding.project.headline": "Start with a project",
  "onboarding.project.lede.local": "Point Claxedo at a folder on this machine, or at a repository to clone. Where the work runs is a later question.",
  "onboarding.project.lede.hosted": "Connect GitHub and choose the repository you want to work on.",
  "onboarding.ai.headline": "Connect an AI",
  "onboarding.ai.lede.local": "The agent runs on a login of yours. Anything found here can be changed later in Settings → Models.",
  "onboarding.ai.lede.hosted": "Connect an account or provider for the agent you want to run. Accounts are stored on this deployment and can be changed later in Settings → Models.",
  "onboarding.execution.headline": "Where it runs",
  "onboarding.execution.lede.local": "Work runs on this machine unless you say otherwise.",
  "onboarding.execution.lede.hosted": "Work runs in a cloud workspace this deployment provides, or on a computer you connect.",
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
  "onboarding.reason.ai.hosted": "Connect an agent account or provider to continue.",
  "onboarding.reason.execution.signIn": "Sign in to a control plane to create a cloud workspace.",
  "onboarding.reason.execution.folder": "Choose a repository instead of a local folder to create a cloud workspace.",
  "onboarding.reason.execution.name": "Name the cloud workspace to create it.",
  "onboarding.failed.noPlacement": "{{project}} has no folder here to open.",
  "onboarding.failed.open": "Created successfully, but could not open it: {{error}}",
  "onboarding.ai.accounts": "Agent accounts",
  "onboarding.ai.loading": "Loading accounts…",
  "onboarding.ai.logins": "Logins on this machine",
  "onboarding.ai.scanning": "Scanning this machine for logins…",
  "onboarding.ai.catalog": "Or connect a provider for",
  "onboarding.execution.label": "Where work runs",
  "onboarding.execution.local.title": "Just this machine",
  "onboarding.execution.local.detail": "Sessions run on this computer, in the project's folder.",
  "onboarding.execution.cloud.title": "A cloud workspace",
  "onboarding.execution.cloud.detail": "Sessions run in a cloud workspace this deployment provides.",
  "onboarding.execution.cloud.name": "Cloud workspace name",
  "onboarding.execution.connect.title": "This computer — connect it",
  "onboarding.execution.connect.detail": "Once your computer is connected, the folders it serves appear here as projects.",
}

export type OnboardingKey = keyof typeof en

const onboardingDictionary = {
  en,
} satisfies Translations<OnboardingKey>

export type OnboardingText = DomainTranslate<OnboardingKey>

export const useOnboardingText = (): OnboardingText => useTranslator(onboardingDictionary)
