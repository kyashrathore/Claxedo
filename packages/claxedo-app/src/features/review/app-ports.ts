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

/**
 * A lazy stand-in for one port: the shell configures the ports after this module
 * is evaluated, so each export must defer the lookup to call time. Reading the
 * port through `select` keeps the argument and return types inferred from the
 * real function, which is why no cast is needed to produce one.
 */
function bind<A extends unknown[], R>(select: (ports: ReviewAppPorts) => (...args: A) => R) {
  return (...args: A) => select(required())(...args)
}

export const useFile = bind((ports) => ports.useFile)
export const usePrompt = bind((ports) => ports.usePrompt)
export const useSDK = bind((ports) => ports.useSDK)
export const createPanePreferences = bind((ports) => ports.createPanePreferences)
export const reviewModePreferenceScope = bind((ports) => ports.reviewModePreferenceScope)
export const DialogReleaseNotes = bind((ports) => ports.DialogReleaseNotes)
export type Highlight = ReleaseNotes.Highlight
