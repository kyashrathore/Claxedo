#!/usr/bin/env bun
// Start a minimal WS+HTTP echo server INSIDE an existing Daytona sandbox and
// return its public preview URL — the upstream the relay bridges to. The relay
// benchmark measures CF's OUTBOUND WS admission (the 6-in-flight-handshake
// window) to this URL; the target app logic only needs to accept WS upgrades
// and echo frames, so a tiny echo server is the correct, controllable target.
//
//   DAYTONA_API_KEY=... bun bench/setup-target.ts --sandbox-id <id> [--port 3939]
//
// Prints (stderr + JSON to bench/reports/target-<stamp>.json):
//   httpUrl / wsUrl  — preview URLs for the echo server port
//   path             — WS echo path ("/ws"); HTTP echo at "/echo", health "/health"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Daytona } from "@daytona/sdk"

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS_DIR = join(PACKAGE_ROOT, "bench/reports")

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const sandboxId = arg("sandbox-id")
const port = Number(arg("port", "3939"))
if (!sandboxId) { console.error("[target] --sandbox-id required"); process.exit(2) }
const key = process.env.DAYTONA_API_KEY
if (!key) { console.error("[target] DAYTONA_API_KEY required"); process.exit(2) }

// A pure-Node (no bun, no deps) WS+HTTP echo server. Sandbox images ship node,
// not bun, so this implements the WS handshake + frame codec by hand. /ws (and
// /) echo WS frames; /echo echoes the HTTP body; /health returns ok.
const ECHO_SERVER = `
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
  function frame(payload){ // server->client text frame, unmasked
    const len=payload.length; let header;
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
      if(op===0x8){ socket.end(); return; } // close
      if(op===0x9){ socket.write(Buffer.from([0x8a,0])); continue; } // ping->pong
      if(op===0x1||op===0x2){ socket.write(frame(payload)); } // echo text/binary
    }
  });
  socket.on("error",()=>{});
});
server.listen(PORT,()=>console.log("echo-server listening on "+PORT));
`.trim()

const daytona = new Daytona({ apiKey: key })
const sandbox = await daytona.get(sandboxId)

// Write the echo server to disk in the sandbox, then start it in a detached
// background session so it survives the setup command returning.
const b64 = Buffer.from(ECHO_SERVER).toString("base64")
console.error("[target] writing echo server…")
await sandbox.process.executeCommand(`bash -lc 'echo ${b64} | base64 -d > /tmp/echo-server.cjs'`)

const sessionId = `bench-echo-${port}`
try { await sandbox.process.deleteSession(sessionId) } catch {}
await sandbox.process.createSession(sessionId)
console.error("[target] starting echo server in background session…")
await sandbox.process.executeSessionCommand(sessionId, {
  command: `bash -lc 'nohup node /tmp/echo-server.cjs > /tmp/echo.log 2>&1 & echo started'`,
  runAsync: true,
} as any)

// Give it a moment, then confirm it is listening from inside the sandbox.
await new Promise((r) => setTimeout(r, 3000))
const check = await sandbox.process.executeCommand(`bash -lc 'curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/health || echo DOWN'`)
console.error(`[target] in-sandbox health -> ${(check as any).result ?? (check as any).stdout ?? "?"}`)

const preview = await sandbox.getPreviewLink(port)
const httpUrl = preview.url
const wsUrl = httpUrl.replace(/^http/, "ws")
console.error(`[target] READY httpUrl=${httpUrl} wsUrl=${wsUrl} token=${preview.token ? "(preview token present)" : "(none)"}`)

await mkdir(REPORTS_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const path = join(REPORTS_DIR, `target-${stamp}.json`)
await writeFile(path, JSON.stringify({ sandboxId, port, httpUrl, wsUrl, path: "/ws", previewToken: preview.token ?? null }, null, 2))
console.error(`[target] wrote ${path}`)
