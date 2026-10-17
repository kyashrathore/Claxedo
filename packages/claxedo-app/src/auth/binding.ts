import type { RunHostedOperation } from "@claxedo/account-contract"
import type { AccountEvents } from "@/server"
import type { Accessor } from "solid-js"
import type { BrowserAuthMethod, BrowserAuthSignInOptions, BrowserAuthSignUpOptions } from "./browser-auth"
import type { AuthUser } from "./display-user"

export type ControlPlaneAccess =
  | { readonly kind: "cookie" }
  | { readonly kind: "port"; readonly run: RunHostedOperation; readonly events: AccountEvents }

export type BrowserSignIn = "idle" | "waiting" | "unfinished"

export type BrowserSignInPort = {
  readonly state: Accessor<BrowserSignIn>
  readonly cancel: () => Promise<void>
}

export type AccountSession = {
  readonly methods: Accessor<readonly BrowserAuthMethod[]>
  readonly user: Accessor<AuthUser | null>
  readonly loading: Accessor<boolean>
  readonly unavailable: Accessor<string | null>
  readonly ended: Accessor<boolean>
  readonly identityResolving: Accessor<boolean>
  readonly offered: (serverIssuesSessions: boolean) => boolean
  readonly signIn: (options?: BrowserAuthSignInOptions) => Promise<void>
  readonly signUp: (options?: BrowserAuthSignUpOptions) => Promise<void>
  readonly signOut: () => Promise<void>
  readonly refresh: () => Promise<void>
  readonly controlPlane: ControlPlaneAccess
  readonly browserSignIn?: BrowserSignInPort
}

export type AccountBinding = {
  readonly open: () => AccountSession
}
