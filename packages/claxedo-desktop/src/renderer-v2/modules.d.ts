declare module "#app-v2" {
  import type { Component, JSX } from "solid-js"
  import type { RouterProps } from "@solidjs/router"
  export function App(props: { readonly router?: Component<RouterProps>; readonly serverUrl?: string }): JSX.Element
}

declare module "#app-v2/styles" {}
