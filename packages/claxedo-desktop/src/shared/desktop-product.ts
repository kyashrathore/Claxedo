export type DesktopChannel = "dev" | "beta" | "prod"

export type DesktopProduct = {
  appId: string
  productName: string
}

const PRODUCTS: Readonly<Record<DesktopChannel, DesktopProduct>> = {
  dev: { appId: "ai.claxedo.desktop.dev", productName: "Claxedo Dev" },
  beta: { appId: "ai.claxedo.desktop.beta", productName: "Claxedo Beta" },
  prod: { appId: "ai.claxedo.desktop", productName: "Claxedo" },
}

export function desktopProduct(channel: DesktopChannel): DesktopProduct {
  return PRODUCTS[channel]
}
