// `@cloudflare/workers-types` resolves to its module typings here, which carry
// the runtime module's classes as `CloudflareWorkersModule` but do not declare
// `cloudflare:workers` itself; its global typings would, and would collide with
// the DOM lib this package compiles against.
declare module "cloudflare:workers" {
  import type { CloudflareWorkersModule } from "@cloudflare/workers-types"
  export const DurableObject: typeof CloudflareWorkersModule.DurableObject
  export type DurableObject<Env = unknown, Props = {}> = CloudflareWorkersModule.DurableObject<Env, Props>
  export const WorkerEntrypoint: typeof CloudflareWorkersModule.WorkerEntrypoint
  export type WorkerEntrypoint<Env = unknown, Props = {}> = CloudflareWorkersModule.WorkerEntrypoint<Env, Props>
}
