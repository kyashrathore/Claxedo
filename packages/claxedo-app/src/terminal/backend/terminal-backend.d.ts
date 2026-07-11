declare module "#terminal-backend" {
  import type { CreateBackendFn } from "./types"
  export const createBackend: CreateBackendFn
}
