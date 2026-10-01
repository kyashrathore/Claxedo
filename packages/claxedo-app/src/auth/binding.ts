import type { ControlPlaneAccess } from "@/server"
import type { Accessor } from "solid-js"
import type { BrowserAuthMethod, BrowserAuthSignInOptions, BrowserAuthSignUpOptions } from "./browser-auth"
import type { AuthUser } from "./display-user"

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
