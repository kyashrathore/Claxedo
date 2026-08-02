import { createSignal } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import {
  AIConnectSurface,
  type AIConnectView,
  type AIVerificationResult,
} from "@/features/onboarding"
import { useServer } from "@/app/connection/server"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"

export function DialogAIConnect(props: {
  onConnected?: (results: AIVerificationResult[]) => void | Promise<void>
}) {
  const dialog = useDialog()
  const server = useServer()
  const globalSDK = useGlobalSDK()
  // The surface branches between choosing a method, detecting, and connecting a
  // provider. In the setup page the action bar drives that; here the dialog owns
  // it, so provider connection happens in place rather than stacking a second
  // dialog on top of this one.
  const [view, setView] = createSignal<AIConnectView>({ kind: "chooser" })

  return (
    <Dialog title="Connect your AI" transition>
      <AIConnectSurface
        localDiscovery={server.isLocal()}
        serverUrl={globalSDK.url}
        defaultScope={server.isLocal() ? "local" : "shared"}
        deviceLoginConfigured={false}
        view={view()}
        onViewChange={setView}
        onConnected={async (results) => {
          await props.onConnected?.(results)
          dialog.close()
        }}
      />
    </Dialog>
  )
}
