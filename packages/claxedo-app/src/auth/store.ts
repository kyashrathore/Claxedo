import { batch, createEffect, createSignal, type Accessor } from "solid-js"
import type { AccountBinding, AccountSession } from "./binding"
import { authMachine, type AuthEvent, type AuthState } from "./model"
import { lastAuthIdentity } from "./persistence"

export type Auth = Omit<AccountSession, "loading" | "browserSignIn" | "ended"> & {
  readonly state: Accessor<AuthState>
  readonly restoringUserId: Accessor<string | undefined>
  readonly cancelSignIn: () => Promise<void>
}

type AuthMachine = ReturnType<typeof authMachine>

function sessionEvent(session: AccountSession, confirming: boolean): AuthEvent {
  if (session.loading()) return { type: "started" }
  const browser = session.browserSignIn?.state()
  if (browser === "waiting") return { type: "browserSignInStarted" }
  const user = session.user()
  if (!user && (confirming || session.ended())) return { type: "expired" }
  if (browser === "unfinished") return { type: "browserSignInUnfinished" }
  const reason = session.unavailable()
  return { type: "settled", user, ...(reason ? { reason } : {}) }
}

function followSession(session: AccountSession, auth: AuthMachine, restored: () => void) {
  let confirming: Promise<void> | undefined
  const settle = () => {
    const event = sessionEvent(session, confirming !== undefined)
    if (event.type === "started") return auth.send(event)
    batch(() => {
      auth.send(event)
      restored()
    })
  }
  createEffect(settle)
  const run = async (task: () => Promise<void>) => {
    if (session.browserSignIn) return task()
    auth.send({ type: "started" })
    try {
      await task()
    } finally {
      settle()
    }
  }
  const confirm = async () => {
    try {
      await session.refresh()
    } catch (error) {
      console.warn("The session could not be read again, so this reader is signed out", { error })
      auth.send({ type: "expired" })
    } finally {
      confirming = undefined
    }
  }
  const refresh = () => {
    if (auth.state().kind !== "signedIn") return Promise.resolve()
    confirming ??= confirm()
    return confirming
  }
  return { run, refresh }
}

export function createAuth(binding: AccountBinding): Auth {
  const session = binding.open()
  const auth = authMachine(session.loading() ? { kind: "signingIn" } : { kind: "signedOut" })
  const [restoring, setRestoring] = createSignal(session.loading())
  const { run, refresh } = followSession(session, auth, () => setRestoring(false))
  return {
    state: auth.state,
    restoringUserId: () => (restoring() ? lastAuthIdentity() : undefined),
    user: session.user,
    methods: session.methods,
    unavailable: session.unavailable,
    identityResolving: session.identityResolving,
    offered: session.offered,
    signIn: (options) => run(() => session.signIn(options)),
    signUp: (options) => run(() => session.signUp(options)),
    signOut: async () => {
      await session.signOut()
      auth.send({ type: "signedOut" })
    },
    refresh,
    cancelSignIn: () => session.browserSignIn?.cancel() ?? Promise.resolve(),
    controlPlane: session.controlPlane,
  }
}
