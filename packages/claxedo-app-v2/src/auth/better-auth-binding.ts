import { createBetterAuthBrowserAdapter } from "./better-auth-adapter"
import { browserAccountBinding } from "./browser-binding"

export const accountBinding = browserAccountBinding(createBetterAuthBrowserAdapter())
