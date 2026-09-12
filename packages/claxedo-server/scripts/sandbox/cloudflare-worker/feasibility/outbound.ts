import { getSandbox } from "@cloudflare/sandbox"
export { Sandbox, ContainerProxy } from "../src/index"

type Env = {
  Sandbox: Parameters<typeof getSandbox>[0]
  PROBE_TOKEN: string
  UPSTREAM_ORIGIN: string
  EGRESS_SECRETS: { put(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
}
const sandboxId = "broker-feasibility"

export default {
  async fetch(request: Request, env: Env) {
    if (!env.PROBE_TOKEN) return new Response("Probe disabled", { status: 503 })
    if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) return new Response("Unauthorized", { status: 401 })
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    const pathname = new URL(request.url).pathname
    if (pathname !== "/" && pathname !== "/destroy") return new Response("Not found", { status: 404 })
    const sandbox = getSandbox(env.Sandbox, sandboxId)
    if (pathname === "/destroy") {
      await sandbox.destroy()
      await env.EGRESS_SECRETS.delete(sandboxId)
      return new Response("destroyed")
    }
    const origin = new URL(env.UPSTREAM_ORIGIN)
    if (origin.protocol !== "https:") return new Response("HTTPS upstream required", { status: 400 })
    const register = async (revision: number) => env.EGRESS_SECRETS.put(sandboxId, JSON.stringify([
      { name: "PROBE_KEY", hosts: [origin.hostname], header: "Authorization", value: `Bearer ${env.PROBE_TOKEN}:${revision}` },
    ]))
    await register(1)
    await sandbox.setOutboundByHosts({ [origin.hostname]: { method: "credential", params: { sandboxId } } })
    const clients = ["node", "bun"]
    const processes = []
    const results = []
    for (const client of clients) {
      const script = `import fs from 'node:fs/promises';
const root='/tmp/broker-${client}';
for(let revision=1;revision<=3;revision++){
  if(revision>1)for(let n=0;;n++){
    if(await fs.access(root+'-continue-'+revision).then(()=>true,()=>false))break;
    if(n>600)throw Error('Controller timed out');
    await new Promise(r=>setTimeout(r,100));
  }
  const response=await fetch(${JSON.stringify(origin.origin)}, {headers:{Authorization:'Bearer claxedo-broker:PROBE_KEY'}});
  const body=await response.text();
  await fs.writeFile(root+'-result-'+revision,JSON.stringify({client:'${client}',revision,pid:process.pid,status:response.status,body}));
}`
      await sandbox.writeFile(`/tmp/broker-${client}.mjs`, script)
      processes.push(await sandbox.startProcess(`${client} /tmp/broker-${client}.mjs`))
    }
    for (const revision of [1, 2, 3]) {
      if (revision === 2) await register(2)
      if (revision === 3) {
        await env.EGRESS_SECRETS.put(sandboxId, "[]")
        await sandbox.setOutboundByHosts({})
      }
      if (revision > 1) for (const client of clients) await sandbox.writeFile(`/tmp/broker-${client}-continue-${revision}`, "continue")
      for (const client of clients) {
        const file = `/tmp/broker-${client}-result-${revision}`
        for (let attempt = 0; ; attempt++) {
          if ((await sandbox.exec(`test -f ${file}`)).exitCode === 0) break
          if (attempt >= 150) throw Error(`${client} phase ${revision} timed out`)
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        const content = (await sandbox.readFile(file)).content
        if (content.includes(env.PROBE_TOKEN)) throw Error("Upstream exposed fixture credential")
        results.push(JSON.parse(content))
      }
    }
    for (const process of processes) {
      const exit = await process.waitForExit(10_000)
      if (exit.exitCode !== 0) throw Error("Client process failed")
    }
    return Response.json(results)
  },
}
