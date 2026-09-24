import type { Component } from "solid-js"
import { CliLoginPage } from "./view/cli-login"
import { DeviceApprovalPage } from "./view/device-approval"
import { LoginPage } from "./view/login"
import { OAuthConsentPage } from "./view/oauth-consent"

export type AuthRoute = {
  readonly id: string
  readonly path: string
  readonly view: Component
}

export const authRoutes: readonly AuthRoute[] = [
  { id: "login", path: "/login", view: LoginPage },
  { id: "deviceApproval", path: "/device", view: DeviceApprovalPage },
  { id: "oauthConsent", path: "/oauth/consent", view: OAuthConsentPage },
  { id: "cliLogin", path: "/cli-login", view: CliLoginPage },
]
