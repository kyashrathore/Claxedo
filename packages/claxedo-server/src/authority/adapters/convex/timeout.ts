// Re-export only: the timeout helper is transport-generic (nothing in it is
// Convex-specific), and the R8 architecture guard rightly flags generic
// control-plane core files that mention the adapter. Canonical home is
// authority/request-timeout.ts; this path stays for adapter-side callers.
export * from "../../../platform/auth/request-timeout"
