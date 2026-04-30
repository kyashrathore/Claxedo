import "solid-js"

declare global {
  const __DEMO_ENABLED__: boolean
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
