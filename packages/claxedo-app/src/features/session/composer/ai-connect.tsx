import { applyAIConnectionResults, type loadAIConnectDialog, type useProviders } from "@/features/session/app-ports"
import type { HarnessSelectionController, HarnessSubmitController } from "@/features/session/harness/controller"
import type { JSX } from "@solidjs/web"

type Input = {
  results: Parameters<typeof applyAIConnectionResults>[0]["results"]
  providers: ReturnType<typeof useProviders>
  scope: string
  directory?: string
  sessionId?: string
  harnessSelectionController?: HarnessSelectionController
  harnessSubmitController: HarnessSubmitController
  setModel: Parameters<typeof applyAIConnectionResults>[0]["setModel"]
}

export async function openComposerAIConnect(
  input: Omit<Input, "results"> & {
    loadDialog: typeof loadAIConnectDialog
    show: (content: () => JSX.Element) => unknown
  },
) {
  const module = await input.loadDialog()
  input.show(() => (
    <module.DialogAIConnect
      onConnected={async (results) => {
        await applyComposerAIConnection({ ...input, results })
      }}
    />
  ))
}

export function applyComposerAIConnection(input: Input) {
  const location = { directory: input.directory, sessionId: input.sessionId }
  const defaults = input.providers.default()
  return applyAIConnectionResults({
    results: input.results,
    providerDefaults: Object.fromEntries(
      [...input.providers.all().values()].map((provider) => [
        provider.id,
        defaults[provider.id] ?? Object.values(provider.models ?? {})[0]?.id,
      ]),
    ),
    setHarness: async (harness) => {
      if (input.harnessSelectionController) {
        await input.harnessSelectionController.setHarness(input.scope, harness, location)
        return
      }
      await input.harnessSubmitController.setHarness(input.scope, harness, location)
    },
    setModel: input.setModel,
  })
}
