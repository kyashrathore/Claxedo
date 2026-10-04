import { createEffect, type Accessor } from "solid-js"
import type { AccountBinding, AccountSession } from "./binding"
import { authMachine, type AuthState } from "./model"

export type Auth = Omit<AccountSession, "loading"> & {
  readonly state: Accessor<AuthState>
}

function followSession(session: AccountSession, auth: ReturnType<typeof authMachine>) {
  const settle = () => {
    const reason = session.unavailable()
    auth.send({ type: "settled", user: session.user(), ...(reason ? { reason } : {}) })
  }
  createEffect(() => {
    if (session.loading()) auth.send({ type: "started" })
    else settle()
  })
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
  const run = followSession(session, auth)
  return {
    state: auth.state,
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
