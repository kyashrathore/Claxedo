import type { RunHostedOperation } from "@claxedo/account-contract"
import type { Accessor } from "solid-js"
import type { BrowserAuthMethod, BrowserAuthSignInOptions, BrowserAuthSignUpOptions } from "./browser-auth"
import type { AuthUser } from "./display-user"

export type ControlPlaneAccess =
  | { readonly kind: "cookie" }
  | { readonly kind: "bearer"; readonly token: (options?: { readonly skipCache?: boolean }) => Promise<string | null> }
  | { readonly kind: "port"; readonly run: RunHostedOperation }

export type AccountSession = {
  readonly methods: Accessor<readonly BrowserAuthMethod[]>
  readonly user: Accessor<AuthUser | null>
  readonly loading: Accessor<boolean>
  readonly unavailable: Accessor<string | null>
  readonly identityResolving: Accessor<boolean>
  readonly offered: (serverIssuesSessions: boolean) => boolean
  readonly signIn: (options?: BrowserAuthSignInOptions) => Promise<void>
  readonly signUp: (options?: BrowserAuthSignUpOptions) => Promise<void>
  readonly signOut: () => Promise<void>
  readonly refresh: () => Promise<void>
  readonly controlPlane: ControlPlaneAccess
}

export type AccountBinding = {
  readonly open: () => AccountSession
}
