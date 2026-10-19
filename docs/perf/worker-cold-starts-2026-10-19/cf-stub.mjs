const stubClass = () => class {
  ctx
  env
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}
export const DurableObject = stubClass()
export const WorkerEntrypoint = stubClass()
export const RpcTarget = stubClass()
export const env = {}
export function waitUntil() {}
