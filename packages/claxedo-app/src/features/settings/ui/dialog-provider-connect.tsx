import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Component } from "solid-js"
import { ProviderConnectCard } from "@/features/settings/ui/provider-connect-card"
import type { ConnectContext } from "@/platform/identity/harness-catalog"

/**
 * Connecting an account, in a dialog.
 *
 * It used to open in place, pushing the rows below it down and leaving a card
 * inside a card. Connecting is a short exchange the user finishes or abandons,
 * and the list it came from should be where they left it either way.
 */
export const DialogProviderConnect: Component<{
  provider: string
  context: ConnectContext
  harness: string
  scope?: string
  credentialId?: string
  onConnected?: () => void | Promise<void>
}> = (props) => {
  const dialog = useDialog()
  // `fit`: the kit's default container is a fixed 512px box with a 280px
  // floor, which left a plan-only method sitting above half a screen of
  // nothing.
  // `claxedo-modal-backdrop` opts into the readable dim: the kit's default
  // overlay is 0.2 of the page colour, which against this app's dark chrome is
  // not visible at all.
  return (
    <Dialog
      size="normal"
      transition
      flush
      fit
      class="claxedo-modal-backdrop"
      aria-label={props.context.vendor}
    >
      <div class="flex max-h-[80vh] min-h-0 flex-col">
        <ProviderConnectCard
          provider={props.provider}
          context={props.context}
          harness={props.harness}
          {...(props.scope === undefined ? {} : { scope: props.scope })}
          {...(props.credentialId === undefined ? {} : { credentialId: props.credentialId })}
          onConnected={async () => {
            await props.onConnected?.()
            dialog.close()
          }}
          onClose={() => dialog.close()}
        />
      </div>
    </Dialog>
  )
}
