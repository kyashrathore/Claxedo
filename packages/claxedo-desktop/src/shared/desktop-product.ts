export type DesktopChannel = "dev" | "beta" | "prod"
export type DesktopRenderer = "v1" | "v2"

export type DesktopProduct = {
  appId: string
  productName: string
}

const PRODUCTS: Readonly<Record<DesktopChannel, DesktopProduct>> = {
  dev: { appId: "ai.claxedo.desktop.dev", productName: "Claxedo Dev" },
  beta: { appId: "ai.claxedo.desktop.beta", productName: "Claxedo Beta" },
  prod: { appId: "ai.claxedo.desktop", productName: "Claxedo" },
}

/**
 * The app id names the userData folder and the product name names the Keychain
 * item, so the v2 renderer gets both of its own and never opens today's
 * profile or its safe-storage key.
 */
const V2_DEV: DesktopProduct = { appId: "ai.claxedo.desktop.v2.dev", productName: "Claxedo V2 Dev" }

export function parseDesktopRenderer(raw: string | undefined): DesktopRenderer {
  if (raw === undefined || raw === "" || raw === "v1") return "v1"
  if (raw === "v2") return "v2"
  throw new Error(`CLAXEDO_DESKTOP_RENDERER must be v1 or v2, got ${JSON.stringify(raw)}`)
}

export function desktopProduct(channel: DesktopChannel, renderer: DesktopRenderer): DesktopProduct {
  if (renderer === "v1") return PRODUCTS[channel]
  if (channel !== "dev") throw new Error(`The v2 renderer is packaged only on the dev channel, not ${channel}`)
  return V2_DEV
}
