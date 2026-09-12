import { ContainerProxy, getSandbox, Sandbox as BaseSandbox } from "@cloudflare/sandbox"
export { ContainerProxy }

export class Sandbox extends BaseSandbox {
  static {
    // The SDK registers handlers through an inherited setter; a class field shadows it.
    Object.assign(this, { outboundHandlers: {
    probe: async (request: Request, _env: unknown, ctx: { params: { revision: number } }) =>
      Response.json({ revision: ctx.params.revision, url: request.url, clientHeader: request.headers.get("x-probe") }),
    } })
  }
  interceptHttps = true
}

export default {
  async fetch(request: Request, env: { Sandbox: Parameters<typeof getSandbox>[0] }) {
    const sandbox = getSandbox(env.Sandbox, "broker-feasibility")
    if (new URL(request.url).pathname === "/destroy") {
      await sandbox.destroy()
      return new Response("destroyed")
    }
    const results = []
    for (const revision of [1, 2]) {
      await sandbox.setOutboundByHost("broker-probe.invalid", "probe", { revision })
      for (const client of ["node", "bun"]) {
        const script = 'fetch("https://broker-probe.invalid/probe",{headers:{"x-probe":"dummy"}}).then(async r=>{if(!r.ok)throw Error(String(r.status));console.log(await r.text())}).catch(e=>{console.error(e);process.exit(1)})'
        const result = await sandbox.exec(`${client} -e '${script}'`)
        results.push({ revision, client, ...result })
      }
    }
    return Response.json(results)
  },
}
