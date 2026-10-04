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
}

export type CloudKey = keyof typeof en

const cloudDictionary = {
  en,
} satisfies Translations<CloudKey>

export type CloudText = DomainTranslate<CloudKey>

export const useCloudText = (): CloudText => useTranslator(cloudDictionary)
