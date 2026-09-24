declare module "#browser-auth-adapter" {
  import type { BrowserAuthAdapter } from "./browser-auth"
  export const createBrowserAuthAdapter: () => BrowserAuthAdapter
}
