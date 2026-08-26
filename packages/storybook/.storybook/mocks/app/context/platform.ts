import type { Platform } from "@/platform/runtime/platform-provider"

const value: Platform = {
  platform: "web",
  openLink() {},
  restart: async () => {},
  back() {},
  forward() {},
  notify: async () => {},
  fetch: globalThis.fetch.bind(globalThis),
  parseMarkdown: async (markdown: string) => markdown,
}

export function usePlatform() {
  return value
}
