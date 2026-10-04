/** The one `cloudflare:workers` export this package extends, typed over the structural `DurableObjectState` of `workerd.d.ts`. */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}
