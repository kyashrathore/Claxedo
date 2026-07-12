import type * as FileContext from "@/app/providers/file"
import type * as Prompt from "@/features/session/providers/prompt"
import type * as SDK from "@/app/providers/sdk/sdk"
import type * as PanePreferences from "@/features/session/preferences/pane"
import type * as ReleaseNotes from "@/app/dialogs/release-notes"

export type ReviewAppPorts = {
  useFile: typeof FileContext.useFile
  usePrompt: typeof Prompt.usePrompt
  useSDK: typeof SDK.useSDK
  createPanePreferences: typeof PanePreferences.createPanePreferences
  reviewModePreferenceScope: typeof PanePreferences.reviewModePreferenceScope
  DialogReleaseNotes: typeof ReleaseNotes.DialogReleaseNotes
}

let ports: ReviewAppPorts | undefined

export function configureReviewAppPorts(value: ReviewAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Review app ports are not configured")
  return ports
}

function bind<K extends keyof ReviewAppPorts>(key: K) {
  return ((...args: never[]) => (required()[key] as (...values: never[]) => unknown)(...args)) as ReviewAppPorts[K]
}

export const useFile = bind("useFile")
export const usePrompt = bind("usePrompt")
export const useSDK = bind("useSDK")
export const createPanePreferences = bind("createPanePreferences")
export const reviewModePreferenceScope = bind("reviewModePreferenceScope")
export const DialogReleaseNotes = bind("DialogReleaseNotes")
export type Highlight = ReleaseNotes.Highlight
