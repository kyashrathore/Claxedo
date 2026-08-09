import "solid-js"

export {}

declare global {
  const __DEMO_ENABLED__: boolean
  const __CLAXEDO_HOSTED_ACTIVATION_ENABLED__: boolean
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
