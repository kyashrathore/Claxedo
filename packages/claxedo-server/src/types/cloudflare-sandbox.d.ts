declare module "@cloudflare/sandbox" {
  export const Sandbox: unknown
  export function getSandbox(binding: unknown, id: string, options?: {
    containerTimeouts?: {
      instanceGetTimeoutMS?: number
      portReadyTimeoutMS?: number
      waitIntervalMS?: number
    }
  }): any
}
