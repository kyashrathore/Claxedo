#!/usr/bin/env bun
// Multi-tunnel setup for the DIAL-IN real-world-shape test. The single-tunnel
// stress (setup-dialin.ts + one loadgen) measures ONE workspace's tunnel eating
// the whole message volume — the shape of a single pathologically hot session,
// NOT the platform. Real hosted use is MANY workspaces, each with its OWN
// dial-in tunnel, its OWN DO room on the relay, and its OWN sandbox app. This
// script builds that shape inside one Daytona sandbox: K independent echo
// servers (one per port) + K dial-in agents (one per workspace/host), so the
// relay sees K distinct tunnels and K distinct rooms.
//
// Caveat (stated so the numbers are read honestly): all K echo+agent processes
// share ONE sandbox's CPU. In real hosted use each workspace is a separate
// machine, so this UNDERSTATES per-tunnel capacity — a conservative test. What
// it faithfully exercises is the RELAY's multi-tunnel fan-out (the shared CF
// layer), which is the thing the single-tunnel test could not.
//
//   DAYTONA_API_KEY=... bun bench/setup-multitunnel.ts \
//     --sandbox-id <id> --count 10 \
//     --relay wss://claxedo-workspace-relay-reeval.kanusdlp.workers.dev \
//     --private-key-pem <abs path to rat.key.pem> \
//     [--base-port 3940] [--htt-ttl 3600]
//
// Writes bench/reports/multitunnel-<stamp>.json: a manifest of
//   [{ workspaceId, hostId, port, directHttpUrl, directWsUrl, previewToken, registered }]
// that bench/multitunnel-run.ts consumes to drive concurrent load.
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Daytona } from "@daytona/sdk"
import { benchHostTunnelTokenFromPrivatePem } from "./lib/tokens"

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS_DIR = join(PACKAGE_ROOT, "bench/reports")
const AGENT_ENTRY = join(PACKAGE_ROOT, "bench/dialin-agent.ts")
const BUNDLE_PATH = join(REPORTS_DIR, "dialin-agent.bundle.cjs")

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback
}

// Same pure-node WS+HTTP echo server as setup-target.ts, parametrized by port so
// each tunnel forwards to its own listener (no shared-echo contention across
// tunnels — each workspace's app is independent, as in production).
function echoServerSource(port: number): string {
  return `
const http = require("http");
const crypto = require("crypto");
const PORT = ${port};
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function accept(key){ return crypto.createHash("sha1").update(key+GUID).digest("base64"); }
const server = http.createServer((req,res)=>{
  if(req.url==="/health"){ res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ok:true})); return; }
  if(req.url==="/echo"){ let b=[]; req.on("data",c=>b.push(c)); req.on("end",()=>{ res.writeHead(200); res.end(Buffer.concat(b)); }); return; }
  res.writeHead(200); res.end("ok");
});
server.on("upgrade",(req,socket)=>{
  const key=req.headers["sec-websocket-key"];
  if(!key){ socket.destroy(); return; }
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: "+accept(key)+"\\r\\n\\r\\n");
  let buf=Buffer.alloc(0);
  function frame(payload){ const len=payload.length; let header;
    if(len<126){ header=Buffer.from([0x81,len]); }
    else if(len<65536){ header=Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
    else { header=Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeUInt32BE(0,2); header.writeUInt32BE(len,6); }
    return Buffer.concat([header,Buffer.from(payload)]);
  }
  socket.on("data",(d)=>{
    buf=Buffer.concat([buf,d]);
    while(buf.length>=2){
      const op=buf[0]&0x0f; const masked=(buf[1]&0x80)!==0; let len=buf[1]&0x7f; let off=2;
      if(len===126){ if(buf.length<4)return; len=buf.readUInt16BE(2); off=4; }
      else if(len===127){ if(buf.length<10)return; len=Number(buf.readBigUInt64BE(2)); off=10; }
      let mask; if(masked){ if(buf.length<off+4)return; mask=buf.slice(off,off+4); off+=4; }
      if(buf.length<off+len)return;
      let payload=buf.slice(off,off+len); buf=buf.slice(off+len);
      if(masked){ const out=Buffer.alloc(len); for(let i=0;i<len;i++)out[i]=payload[i]^mask[i&3]; payload=out; }
      if(op===0x8){ socket.end(); return; }
      if(op===0x9){ socket.write(Buffer.from([0x8a,0])); continue; }
      if(op===0x1||op===0x2){ socket.write(frame(payload)); }
    }
  });
  socket.on("error",()=>{});
});
server.listen(PORT,()=>console.log("echo-server listening on "+PORT));
`.trim()
}

async function bundleAgent(): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true })
  await build({
    entryPoints: [AGENT_ENTRY],
    outfile: BUNDLE_PATH,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "warning",
  })
  console.error(`[multitunnel] bundled agent -> ${BUNDLE_PATH}`)
  return BUNDLE_PATH
}

async function resolvePem(value: string): Promise<string> {
  if (value.includes("BEGIN")) return value.replaceAll("\\n", "\n")
  return await readFile(value, "utf8")
}

async function main() {
  const sandboxId = arg("sandbox-id")
  const relayUrl = arg("relay")
  const count = Number(arg("count", "10"))
  const basePort = Number(arg("base-port", "3940"))
  const httpTtl = Number(arg("htt-ttl", "3600"))
  const pemArg = arg("private-key-pem")
  if (!sandboxId || !relayUrl || !pemArg) {
    console.error("[multitunnel] --sandbox-id, --relay and --private-key-pem are required")
    process.exit(2)
  }
  const key = process.env.DAYTONA_API_KEY
  if (!key) { console.error("[multitunnel] DAYTONA_API_KEY required"); process.exit(2) }
  const privateKeyPem = await resolvePem(pemArg)

  const bundlePath = await bundleAgent()
  const bundleSource = await readFile(bundlePath, "utf8")
  const bundleB64 = Buffer.from(bundleSource).toString("base64")

  const daytona = new Daytona({ apiKey: key })
  const sandbox = await daytona.get(sandboxId)

  // Upload the agent bundle once; all K agents run the same .cjs with distinct env.
  console.error(`[multitunnel] uploading agent bundle into sandbox…`)
  await sandbox.process.executeCommand(`bash -lc 'echo ${bundleB64} | base64 -d > /tmp/dialin-agent.cjs'`)

  const manifest: Array<{
    workspaceId: string
    hostId: string
    port: number
    directHttpUrl: string
    directWsUrl: string
    previewToken: string | null
    registered: boolean
  }> = []

  for (let i = 0; i < count; i++) {
    const port = basePort + i
    const workspaceId = `ws_reeval_mt_${i}`
    // hostId MUST match what the browser RAT resolves to. loadgen mints RATs with
    // the tokens-lib default hostId ("host_bench"), and each workspace lives in
    // its OWN DO room, so registering every tunnel as "host_bench" is unambiguous
    // (one tunnel per room) and matches the RAT the relay will look up.
    const hostId = "host_bench"

    // 1. Start an echo server for this tunnel on its own port.
    const echoB64 = Buffer.from(echoServerSource(port)).toString("base64")
    await sandbox.process.executeCommand(`bash -lc 'echo ${echoB64} | base64 -d > /tmp/echo-${port}.cjs'`)
    const echoSession = `bench-echo-${port}`
    try { await sandbox.process.deleteSession(echoSession) } catch {}
    await sandbox.process.createSession(echoSession)
    await sandbox.process.executeSessionCommand(echoSession, {
      command: `bash -lc 'nohup node /tmp/echo-${port}.cjs > /tmp/echo-${port}.log 2>&1 & echo started'`,
      runAsync: true,
    } as any)

    // 2. Mint this tunnel's HTT and write it to a per-port file.
    const htt = await benchHostTunnelTokenFromPrivatePem(privateKeyPem, {
      workspaceIds: [workspaceId],
      hostId,
      ttlSeconds: httpTtl,
    })
    const httB64 = Buffer.from(htt).toString("base64")
    await sandbox.process.executeCommand(`bash -lc 'umask 077; echo ${httB64} | base64 -d > /tmp/dialin-${i}.htt'`)

    // 3. Start this tunnel's agent in its own background session.
    const agentSession = `bench-dialin-${i}`
    try { await sandbox.process.deleteSession(agentSession) } catch {}
    await sandbox.process.createSession(agentSession)
    const startCmd = [
      "RELAY_URL=" + JSON.stringify(relayUrl),
      "HOST_ID=" + JSON.stringify(hostId),
      "WORKSPACE_ID=" + JSON.stringify(workspaceId),
      "LOCAL_URL=" + JSON.stringify(`http://localhost:${port}`),
      `HTT="$(cat /tmp/dialin-${i}.htt)"`,
      `nohup node /tmp/dialin-agent.cjs > /tmp/dialin-${i}.log 2>&1 & echo started`,
    ].join(" ")
    await sandbox.process.executeSessionCommand(agentSession, {
      command: `bash -lc '${startCmd}'`,
      runAsync: true,
    } as any)

    // 4. Preview URL for this echo (the DIRECT baseline the loadgen subtracts).
    const preview = await sandbox.getPreviewLink(port)
    manifest.push({
      workspaceId,
      hostId,
      port,
      directHttpUrl: preview.url,
      directWsUrl: preview.url.replace(/^http/, "ws"),
      previewToken: preview.token ?? null,
      registered: false,
    })
    console.error(`[multitunnel] tunnel ${i}: workspace=${workspaceId} port=${port} started`)
  }

  // Poll each agent log for its `open` event.
  console.error(`[multitunnel] waiting for ${count} tunnels to register…`)
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline && manifest.some((m) => !m.registered)) {
    await new Promise((r) => setTimeout(r, 2000))
    for (let i = 0; i < count; i++) {
      if (manifest[i]!.registered) continue
      const tail = await sandbox.process.executeCommand(`bash -lc 'cat /tmp/dialin-${i}.log 2>/dev/null || true'`)
      const log = String((tail as any).result ?? (tail as any).stdout ?? "")
      if (/"type":"open"/.test(log)) manifest[i]!.registered = true
    }
  }
  const registered = manifest.filter((m) => m.registered).length
  console.error(`[multitunnel] ${registered}/${count} tunnels registered`)

  await mkdir(REPORTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const path = join(REPORTS_DIR, `multitunnel-${stamp}.json`)
  await writeFile(path, JSON.stringify({ sandboxId, relayUrl, count, basePort, manifest }, null, 2))
  // Also write a stable path the runner picks up by default.
  await writeFile(join(REPORTS_DIR, "multitunnel-latest.json"), JSON.stringify({ sandboxId, relayUrl, count, basePort, manifest }, null, 2))
  console.error(`[multitunnel] wrote ${path}`)
  process.exit(registered === count ? 0 : 1)
}

main().catch((err) => {
  console.error("[multitunnel] failed:", err)
  process.exit(1)
})
