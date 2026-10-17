import { createSignal, onCleanup, type Accessor } from "solid-js"
import { accountEvents } from "@/server"
import type { AccountBinding, AccountSession, BrowserSignIn, ControlPlaneAccess } from "./binding"
import { desktopAccountState, type DesktopAccountBridge, type DesktopAccountState } from "./desktop-bridge"

type Adopt = (answer: () => Promise<unknown>) => Promise<void>

function followBridge(bridge: DesktopAccountBridge) {
  const [state, setState] = createSignal<DesktopAccountState>({ kind: "loading" })
  let revision = 0
  onCleanup(
    bridge.onState((next) => {
      revision++
      setState(desktopAccountState(next))
    }),
  )
  const adopt: Adopt = async (answer) => {
    const startedAt = revision
    try {
      const next = desktopAccountState(await answer())
      if (startedAt === revision) setState(next)
    } catch (error) {
      console.error("The desktop account did not answer", { error })
      if (startedAt === revision) setState({ kind: "unavailable", reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { state, adopt }
}

function portAccess(bridge: DesktopAccountBridge, refresh: () => Promise<void>): ControlPlaneAccess {
  return {
    kind: "port",
    events: accountEvents(bridge),
    run: async (operation, input) => {
      try {
        return await bridge.run(operation, input)
      } catch (error) {
        await refresh()
        throw error
      }
    },
  }
}

function readers(state: Accessor<DesktopAccountState>) {
  return {
    user: () => {
      const now = state()
      return now.kind === "signed" ? now.user : null
    },
    loading: () => state().kind === "loading",
    unavailable: () => {
      const now = state()
      return now.kind === "unavailable" ? now.reason : null
    },
    ended: () => state().kind === "revoked",
    identityResolving: () => {
      const now = state()
      return now.kind === "signed" && now.identity === "resolving"
    },
  }
}

function browserSignIn(state: Accessor<DesktopAccountState>): BrowserSignIn {
  const kind = state().kind
  if (kind === "awaitingBrowser") return "waiting"
  return kind === "signInUnfinished" ? "unfinished" : "idle"
}

export function desktopAccountBinding(bridge: DesktopAccountBridge, options: { readonly signInEnabled: boolean }): AccountBinding {
  return {
    open: (): AccountSession => {
      const { state, adopt } = followBridge(bridge)
      const refresh = () => adopt(bridge.state)
      void refresh()
      return {
        ...readers(state),
        methods: () => [],
        offered: () => options.signInEnabled,
        signIn: () => adopt(bridge.signIn),
        signUp: () => adopt(bridge.signIn),
        signOut: () => adopt(bridge.signOut),
        refresh,
        controlPlane: portAccess(bridge, refresh),
        browserSignIn: { state: () => browserSignIn(state), cancel: () => adopt(bridge.cancelSignIn) },
      }
    },
  }
}
