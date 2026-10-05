import { batch, createEffect, createSignal, type Accessor } from "solid-js"
import type { AccountBinding, AccountSession } from "./binding"
import { authMachine, type AuthState } from "./model"
import { lastAuthIdentity } from "./persistence"

export type Auth = Omit<AccountSession, "loading"> & {
  readonly state: Accessor<AuthState>
  readonly restoringUserId: Accessor<string | undefined>
}

function followSession(session: AccountSession, auth: ReturnType<typeof authMachine>, restored: () => void) {
  const settle = () => {
    if (session.loading()) return auth.send({ type: "started" })
    const reason = session.unavailable()
    batch(() => {
      auth.send({ type: "settled", user: session.user(), ...(reason ? { reason } : {}) })
      restored()
    })
  }
  createEffect(settle)
  return async (task: () => Promise<void>) => {
    auth.send({ type: "started" })
    try {
      await task()
    } finally {
      settle()
    }
  }
}

export function createAuth(binding: AccountBinding): Auth {
  const session = binding.open()
  const auth = authMachine(session.loading() ? { kind: "signingIn" } : { kind: "signedOut" })
  const [restoring, setRestoring] = createSignal(session.loading())
  const run = followSession(session, auth, () => setRestoring(false))
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
    refresh: async () => {
      try {
        await session.refresh()
      } catch (error) {
        auth.send({ type: "expired" })
        throw error
      }
    },
    controlPlane: session.controlPlane,
  }
}
