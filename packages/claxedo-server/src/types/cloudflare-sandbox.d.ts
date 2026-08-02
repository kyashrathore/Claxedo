declare module "@cloudflare/sandbox" {
  export const Sandbox: unknown
  export function getSandbox(binding: unknown, id: string): any
}
