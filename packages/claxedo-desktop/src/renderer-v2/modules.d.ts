declare module "#app-v2" {
  import type { JSX } from "solid-js"
  export function App(props: {
    readonly router?: (props: { readonly children?: JSX.Element }) => JSX.Element
    readonly serverUrl?: string
  }): JSX.Element
}

declare module "#app-v2/styles" {}
