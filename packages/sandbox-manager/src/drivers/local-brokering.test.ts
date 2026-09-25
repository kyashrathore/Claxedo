import { afterEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import net from "node:net"
import { createLocalBrokeringSandboxDriver } from "./local-brokering"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

function sendProxy(proxy: URL, destination: string, header: string) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, path: destination, method: "POST", headers: { authorization: header } }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode ?? 0))
    })
    request.on("error", reject)
    request.end("{}")
  })
}

function sendConnect(proxy: URL, host: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
    })
    socket.once("data", (data) => {
      socket.destroy()
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data.toString())?.[1] ?? 0))
    })
    socket.on("error", reject)
  })
}

test("local broker keeps the key outside the runtime and withdraws it on ensure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-broker-test-"))
  roots.push(root)
  const received: Array<{ authorization: string; url: string }> = []
  const upstream = http.createServer((request, response) => {
    received.push({ authorization: request.headers.authorization ?? "", url: request.url ?? "" })
    response.writeHead(200).end("ok")
  })
  const controlPlane = http.createServer((_request, response) => response.writeHead(200).end("ok"))
  const relay = http.createServer((_request, response) => response.writeHead(200).end("ok"))
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  await new Promise<void>((resolve) => controlPlane.listen(0, "127.0.0.1", resolve))
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  try {
    const address = upstream.address()
    const controlAddress = controlPlane.address()
    const relayAddress = relay.address()
    if (!address || typeof address === "string" || !controlAddress || typeof controlAddress === "string" || !relayAddress || typeof relayAddress === "string") throw new Error("test upstream has no port")
    const origin = `http://127.0.0.1:${address.port}`
    const inheritedEnv = { CONTROL_PLANE_ORIGIN: `http://127.0.0.1:${controlAddress.port}`, RELAY_ORIGIN: `http://127.0.0.1:${relayAddress.port}`, VENDOR_PORT: String(address.port), CA_KEY: "" }
    const executable = process.execPath
    const args = ["-e", `require('node:http').createServer((req,res)=>{if(req.url==='/global/health')res.end('ok');else if(req.url.startsWith('/fetch/')){const origin=req.url==='/fetch/control'?process.env.CONTROL_PLANE_ORIGIN:process.env.RELAY_ORIGIN;fetch(origin).then(r=>res.end(String(r.status))).catch(e=>res.end(e.code||e.message))}else if(req.url.startsWith('/tls/')){const host=req.url.slice(5);fetch('https://'+host+'/v1/messages?proof=1',{method:'POST',headers:{authorization:'Bearer '+process.env.MODEL_KEY},body:'{}',signal:AbortSignal.timeout(3000)}).then(async r=>res.end(JSON.stringify({status:r.status,body:await r.text()}))).catch(e=>res.end(String(e)+' '+String(e.cause)))}else if(req.url==='/ca-key'){try{require('node:fs').readFileSync(process.env.CA_KEY);res.end('readable')}catch(e){res.end(e.code)}}else if(req.url==='/direct/vendor'){const s=require('node:net').connect(Number(process.env.VENDOR_PORT),'127.0.0.1');s.on('connect',()=>{s.destroy();res.end('connected')});s.on('error',(e)=>res.end(e.code))}else if(req.url==='/ps'){require('node:child_process').execFile('/bin/ps',['-p',String(process.pid),'-o','lstart='],(error,stdout)=>res.end(error?String(error):stdout.trim()))}else res.end(JSON.stringify(process.env))}).listen(process.env.WORKSPACE_RUNTIME_PORT,'127.0.0.1')`]
    const driver = createLocalBrokeringSandboxDriver({
      root, executable, args, allowedOrigins: [origin], upstreams: { "https://api.openai.com": origin }, controlPlaneOrigin: `http://127.0.0.1:${controlAddress.port}`,
      relayOrigin: `http://127.0.0.1:${relayAddress.port}`,
      inheritedEnv,
    })
    const createdCaDirectory = (await fs.readdir(root, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.startsWith("local-broker-ca-"))?.name
    if (!createdCaDirectory) throw new Error("test CA was not created")
    const caKey = path.join(root, createdCaDirectory, "ca.key")
    expect((await fs.readFile(caKey, "utf8"))).toContain("PRIVATE KEY")
    inheritedEnv.CA_KEY = caKey
    const key = "actual-provider-secret-unique"
    const placeholder = "claxedo-broker:MODEL_KEY"
    const ensure = { workspaceId: "one", homeRegion: "local", epoch: 1, labels: {}, secrets: [{ name: "MODEL_KEY", value: key, hosts: [new URL(origin).host, "api.openai.com", "unmapped.example"], header: "authorization", scheme: "Bearer", methods: ["POST"], pathPrefixes: ["/v1"] }] }
    const target = await driver.ensureHost(ensure)
    if ("provisioning" in target) throw new Error("local test driver did not return a ready target")
    const env = await (await fetch(target.url)).json() as Record<string, string>
    expect(JSON.stringify(env)).not.toContain(key)
    expect(env.MODEL_KEY).toBe(placeholder)
    expect(await (await fetch(`${target.url}/fetch/control`)).text()).toBe("200")
    expect(await (await fetch(`${target.url}/fetch/relay`)).text()).toBe("200")
    expect(await (await fetch(`${target.url}/ps`)).text()).toMatch(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/)
    expect(await (await fetch(`${target.url}/direct/vendor`)).text()).not.toBe("connected")
    expect(["EPERM", "EACCES", "ENOENT"]).toContain(await (await fetch(`${target.url}/ca-key`)).text())
    expect(await (await fetch(`${target.url}/tls/api.openai.com`)).text()).toBe(JSON.stringify({ status: 200, body: "ok" }))
    expect(await (await fetch(`${target.url}/tls/unknown.example`)).text()).not.toContain('"status":200')
    expect(await (await fetch(`${target.url}/tls/unmapped.example`)).text()).not.toContain('"status":200')
    const files = await fs.readdir(root, { recursive: true })
    for (const file of files) {
      const full = path.join(root, file)
      if ((await fs.stat(full)).isFile()) expect(await fs.readFile(full, "utf8")).not.toContain(key)
    }
    const proxy = new URL(env.HTTP_PROXY)
    expect(await sendConnect(proxy, "unknown.example")).toBe(403)
    expect(await sendConnect(proxy, "unmapped.example")).toBe(403)
    expect(await sendProxy(proxy, `${origin}/v1/messages`, `Bearer ${placeholder}`)).toBe(200)
    expect(received).toEqual([{ authorization: `Bearer ${key}`, url: "/v1/messages?proof=1" }, { authorization: `Bearer ${key}`, url: "/v1/messages" }])
    expect(await sendProxy(proxy, "http://unknown.invalid/v1/messages", `Bearer ${placeholder}`)).toBe(403)
    const withdrawn = await driver.ensureHost({ ...ensure, secrets: [] })
    if ("provisioning" in withdrawn) throw new Error("local test driver did not return a withdrawn target")
    const withdrawnEnv = await (await fetch(withdrawn.url)).json() as Record<string, string>
    expect(withdrawnEnv.MODEL_KEY).toBeUndefined()
    expect(await sendProxy(new URL(withdrawnEnv.HTTP_PROXY), `${origin}/v1/messages`, `Bearer ${placeholder}`)).toBe(403)
    expect(received).toEqual([{ authorization: `Bearer ${key}`, url: "/v1/messages?proof=1" }, { authorization: `Bearer ${key}`, url: "/v1/messages" }])
    await driver.stop?.(withdrawn)
  } finally {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    controlPlane.closeAllConnections()
    await new Promise<void>((resolve) => controlPlane.close(() => resolve()))
    relay.closeAllConnections()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
  }
})
