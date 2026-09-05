import "solid-js"

declare global {
  const __DEMO_ENABLED__: boolean
  /** Compile-time product composition. False means no Agent Plugins UI module is emitted. */
  const __CLAXEDO_AGENT_PLUGINS_ENABLED__: boolean
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
