import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import {
  AIConnectSurface,
  aiConnectFailureCopy,
  invalidateAIConnectQueries,
  verifyProviderAIConnections,
  type AIVerificationResult,
} from "@/features/onboarding"
import { useServer } from "@/app/connection/server"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { DialogConnectProvider } from "@/app/dialogs/connect-provider"

export function DialogAIConnect(props: {
  onConnected?: (results: AIVerificationResult[]) => void | Promise<void>
}) {
  const dialog = useDialog()
  const server = useServer()
  const globalSDK = useGlobalSDK()

  return (
    <Dialog title="Connect your AI" transition>
      <AIConnectSurface
        localDiscovery={server.isLocal()}
        serverUrl={globalSDK.url}
        defaultScope={server.isLocal() ? "local" : "shared"}
        deviceLoginConfigured={false}
        onProviderConnect={(providerId) => dialog.show(() => (
          <DialogConnectProvider
            provider={providerId}
            onConnected={async () => {
              const results = await verifyProviderAIConnections({ serverUrl: globalSDK.url, providerId })
              await invalidateAIConnectQueries()
              const failed = results.find((result) => result.result !== "ok")
              if (failed && failed.result !== "ok") throw new Error(aiConnectFailureCopy(failed.result))
              await props.onConnected?.(results)
            }}
          />
        ))}
        onConnected={async (results) => {
          await props.onConnected?.(results)
          dialog.close()
        }}
      />
    </Dialog>
  )
}
