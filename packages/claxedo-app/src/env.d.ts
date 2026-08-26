import "solid-js"

declare global {
  const __DEMO_ENABLED__: boolean
  /** Scalar compile-time diagnostic owner; null in every ordinary build. */
  const __CLAXEDO_SUBTRACTION_OWNER__: "renderer" | "host" | "terminal" | "app" | null
}

// NOTE (divorce plan 006): upstream packages/app/src/env.d.ts declares
// ImportMetaEnv (VITE_OPENCODE_* / VITE_SENTRY_* vars), but that declaration
// is module-scoped (the file has an `export`), so it never actually augmented
// import.meta.env — vite/client's index signature governed. We intentionally
// do NOT globalize it here: doing so retroactively type-narrows vendored
// upstream files (e.g. titlebar.tsx ChannelIndicator) that upstream itself
// never typechecked against it. Behavior and typing stay identical to the
// pre-divorce baseline.

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
