import type { RouteEntry } from "@/shell"
import { authScreen } from "./view/auth-screen"
import { CliLoginPage } from "./view/cli-login"
import { DeviceApprovalPage } from "./view/device-approval"
import { LoginPage } from "./view/login"
import { OAuthConsentPage } from "./view/oauth-consent"

export const authRoutes: readonly RouteEntry[] = [
  { id: "auth.login", path: "/login", view: authScreen(LoginPage) },
  { id: "auth.deviceApproval", path: "/device", view: authScreen(DeviceApprovalPage) },
  { id: "auth.oauthConsent", path: "/oauth/consent", view: authScreen(OAuthConsentPage) },
  { id: "auth.cliLogin", path: "/cli-login", view: authScreen(CliLoginPage) },
]
