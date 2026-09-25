import { expect, type Page } from "@playwright/test"

export const APP_PLUGIN_WARNING = {
  desktop: /run inside this app, unsandboxed, with its full access on this computer\. An app plugin sees what you see, acts as you on your server, and can open links in your browser that carry your data out\. Turn on only app plugins you trust\./,
  web: /run sandboxed in frames\. An app plugin sees only what this app passes it and reaches only the server routes and operations its manifest names, as you, and nothing else on the network\. Turn on only app plugins you trust\./,
} as const

export function appPluginDialog(page: Page, title: string) {
  return page.getByRole("dialog", { name: title })
}

export async function approveAppPlugin(page: Page, title: string, warning: RegExp) {
  const dialog = appPluginDialog(page, title)
  await expect(dialog.getByRole("note")).toHaveText(warning)
  await dialog.getByRole("button", { name: "Turn on" }).click()
  await expect(dialog).toHaveCount(0)
}

export function appPluginRow(page: Page, name: string) {
  return page.getByRole("list", { name: "App plugins" }).getByRole("listitem", { name })
}
