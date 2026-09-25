import type { ElectronApplication } from "@playwright/test"

export type SystemBrowser = { opened(): Promise<string[]> }

export async function interceptSystemBrowser(electron: ElectronApplication): Promise<SystemBrowser> {
  await electron.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.defineProperty(globalThis, "__claxedoSystemBrowser", { configurable: true, value: opened })
    Object.defineProperty(shell, "openExternal", { configurable: true, value: async (url: string) => void opened.push(url) })
  })
  return {
    opened: () => electron.evaluate(() => [...((globalThis as { __claxedoSystemBrowser?: string[] }).__claxedoSystemBrowser ?? [])]),
  }
}
