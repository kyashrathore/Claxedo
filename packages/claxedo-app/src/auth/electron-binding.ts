import { desktopAccountBinding } from "./desktop-binding"
import { desktopAccountBridge } from "./desktop-bridge"

const bridge = desktopAccountBridge(globalThis)
if (!bridge) throw new Error("The desktop renderer has no account bridge; the preload did not expose api.account")

export const accountBinding = desktopAccountBinding(bridge, { signInEnabled: import.meta.env.VITE_CLAXEDO_HOSTED_ACTIVATION === "true" })
