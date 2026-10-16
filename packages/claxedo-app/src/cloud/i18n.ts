import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

const en = {
  "cloud.status.provisioning": "Setting up",
  "cloud.status.acquiring": "Getting a machine",
  "cloud.status.cloning": "Cloning the repository",
  "cloud.status.startingRuntime": "Starting the workspace",
  "cloud.status.waitingHealth": "Almost ready",
  "cloud.status.starting": "Starting",
  "cloud.status.ready": "Running",
  "cloud.status.stopping": "Stopping",
  "cloud.status.stopped": "Asleep",
  "cloud.status.failed": "Failed",
  "cloud.command.start.failed": "Couldn't start: {{reason}}",
  "cloud.command.stop.failed": "Couldn't stop: {{reason}}",
  "cloud.command.stop.unsaved": "Stopped without saving the latest changes.",
  "cloud.command.remove.failed": "Couldn't delete: {{reason}}",
  "cloud.command.startFresh.failed": "Couldn't start fresh: {{reason}}",
  "cloud.startFresh": "Start fresh",
  "cloud.startFresh.title": "Start {{name}} fresh?",
  "cloud.startFresh.body": "Files and installed packages that are not in the repository are lost.",
  "cloud.startFresh.cancel": "Cancel",
  "cloud.wake.step.starting": "Starting the machine",
  "cloud.wake.step.resuming": "Resuming the machine",
  "cloud.wake.step.restoring": "Restoring your files",
  "cloud.wake.step.image": "Downloading the workspace image",
  "cloud.wake.step.workspace": "Starting the workspace",
  "cloud.wake.step.runtime": "Starting the agent runtime",
  "cloud.wake.step.connecting": "Connecting to the workspace",
  "cloud.wake.stepFor": "{{step}} · {{elapsed}}",
  "cloud.wake.done": "Done: {{steps}}",
  "cloud.wake.done.machine": "machine",
  "cloud.wake.done.image": "workspace image",
  "cloud.wake.done.runtime": "agent runtime",
  "cloud.wake.total": "{{elapsed}} in all",
  "cloud.wake.retrying": "Start failed, retrying: {{reason}}",
  "cloud.wake.nextTry": "next try in {{wait}}",
  "cloud.unnamed": "Cloud workspace",
  "cloud.size.label": "Machine size",
  "cloud.size.small": "Small",
  "cloud.size.small.description": "Uses the least. Enough for reading code and small edits.",
  "cloud.size.default": "Default",
  "cloud.size.default.description": "Fits most projects.",
  "cloud.size.large": "Large",
  "cloud.size.large.description": "More room for big builds and test suites. Uses more.",
}

export type CloudKey = keyof typeof en

const cloudDictionary = {
  en,
} satisfies Translations<CloudKey>

export type CloudText = DomainTranslate<CloudKey>

export const useCloudText = (): CloudText => useTranslator(cloudDictionary)
