import { batch, createEffect, createSignal, type Accessor } from "solid-js"
import type { AccountBinding, AccountSession } from "./binding"
import { authMachine, type AuthState } from "./model"
import { lastAuthIdentity } from "./persistence"

export type Auth = Omit<AccountSession, "loading"> & {
  readonly state: Accessor<AuthState>
  readonly restoringUserId: Accessor<string | undefined>
}

type AuthMachine = ReturnType<typeof authMachine>

function followSession(session: AccountSession, auth: AuthMachine, restored: () => void) {
  let confirming: Promise<void> | undefined
  const settle = () => {
    if (session.loading()) return auth.send({ type: "started" })
    const reason = session.unavailable()
    const user = session.user()
    batch(() => {
      auth.send(confirming && !user ? { type: "expired" } : { type: "settled", user, ...(reason ? { reason } : {}) })
      restored()
    })
  }
  createEffect(settle)
  const run = async (task: () => Promise<void>) => {
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
    controlPlane: session.controlPlane,
  }
}
