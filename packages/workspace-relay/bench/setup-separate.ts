// One tunnel per SEPARATE sandbox (dedicated CPU per workspace = real hosted
// shape). Reuses the already-bundled dialin-agent.bundle.cjs. Writes a manifest
// multitunnel-run.ts can drive. Each sandbox: own echo (localhost:3939) + own
// dial-in agent, registered as a distinct workspace, all host_bench.
import { readFile, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Daytona } from "@daytona/sdk"
import { benchHostTunnelTokenFromPrivatePem } from "./lib/tokens"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS = join(ROOT, "bench/reports")
const arg=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i>=0&&process.argv[i+1]&&!process.argv[i+1].startsWith("--")?process.argv[i+1]:f}
const ECHO=(port)=>`const http=require("http"),crypto=require("crypto"),PORT=${port},GUID="258EAFA5-E914-47DA-95CA-C5AB0DC85B11";function a(k){return crypto.createHash("sha1").update(k+GUID).digest("base64")}const s=http.createServer((q,r)=>{if(q.url==="/health"){r.writeHead(200,{"content-type":"application/json"});r.end(JSON.stringify({ok:true}));return}r.writeHead(200);r.end("ok")});s.on("upgrade",(q,sock)=>{const k=q.headers["sec-websocket-key"];if(!k){sock.destroy();return}sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: "+a(k)+"\\r\\n\\r\\n");let b=Buffer.alloc(0);function fr(p){const l=p.length;let h;if(l<126)h=Buffer.from([0x81,l]);else if(l<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(l,2)}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeUInt32BE(0,2);h.writeUInt32BE(l,6)}return Buffer.concat([h,Buffer.from(p)])}sock.on("data",d=>{b=Buffer.concat([b,d]);while(b.length>=2){const op=b[0]&0x0f,m=(b[1]&0x80)!==0;let l=b[1]&0x7f,o=2;if(l===126){if(b.length<4)return;l=b.readUInt16BE(2);o=4}else if(l===127){if(b.length<10)return;l=Number(b.readBigUInt64BE(2));o=10}let mk;if(m){if(b.length<o+4)return;mk=b.slice(o,o+4);o+=4}if(b.length<o+l)return;let p=b.slice(o,o+l);b=b.slice(o+l);if(m){const ot=Buffer.alloc(l);for(let i=0;i<l;i++)ot[i]=p[i]^mk[i&3];p=ot}if(op===0x8){sock.end();return}if(op===0x9){sock.write(Buffer.from([0x8a,0]));continue}if(op===0x1||op===0x2)sock.write(fr(p))}});sock.on("error",()=>{})});s.listen(PORT,()=>console.log("echo "+PORT))`
async function main(){
  const relay=arg("relay"), pemPath=arg("private-key-pem"), ids=arg("sandbox-ids").split(",")
  const pem=await readFile(pemPath,"utf8")
  const bundle=await readFile(join(REPORTS,"dialin-agent.bundle.cjs"),"utf8")
  const bundleB64=Buffer.from(bundle).toString("base64")
  const d=new Daytona({apiKey:process.env.DAYTONA_API_KEY})
  const manifest=[]
  await Promise.all(ids.map(async(id,i)=>{
    const sb=await d.get(id), port=3939, ws=`ws_sep_${i}`
    const echoB64=Buffer.from(ECHO(port)).toString("base64")
    await sb.process.executeCommand(`bash -lc 'echo ${echoB64}|base64 -d>/tmp/echo.cjs'`)
    try{await sb.process.deleteSession("e")}catch{}; await sb.process.createSession("e")
    await sb.process.executeSessionCommand("e",{command:`bash -lc 'nohup node /tmp/echo.cjs>/tmp/echo.log 2>&1 & echo ok'`,runAsync:true})
    await sb.process.executeCommand(`bash -lc 'echo ${bundleB64}|base64 -d>/tmp/agent.cjs'`)
    const htt=await benchHostTunnelTokenFromPrivatePem(pem,{workspaceIds:[ws],hostId:"host_bench",ttlSeconds:3600})
    await sb.process.executeCommand(`bash -lc 'umask 077;echo ${Buffer.from(htt).toString("base64")}|base64 -d>/tmp/a.htt'`)
    try{await sb.process.deleteSession("a")}catch{}; await sb.process.createSession("a")
    const cmd=[`RELAY_URL=${JSON.stringify(relay)}`,`HOST_ID="host_bench"`,`WORKSPACE_ID=${JSON.stringify(ws)}`,`LOCAL_URL="http://localhost:${port}"`,`HTT="$(cat /tmp/a.htt)"`,`nohup node /tmp/agent.cjs>/tmp/agent.log 2>&1 & echo ok`].join(" ")
    await sb.process.executeSessionCommand("a",{command:`bash -lc '${cmd}'`,runAsync:true})
    let reg=false
    for(let t=0;t<20&&!reg;t++){await new Promise(r=>setTimeout(r,2000));const tl=await sb.process.executeCommand(`bash -lc 'cat /tmp/agent.log 2>/dev/null||true'`);if(/"type":"open"/.test(String(tl.result??tl.stdout??"")))reg=true}
    const pv=await sb.getPreviewLink(port)
    manifest[i]={workspaceId:ws,hostId:"host_bench",port,sandboxId:id,directHttpUrl:pv.url,directWsUrl:pv.url.replace(/^http/,"ws"),previewToken:pv.token??null,registered:reg}
    console.error(`sandbox ${i} ${id} ws=${ws} registered=${reg}`)
  }))
  await writeFile(join(REPORTS,"separate-latest.json"),JSON.stringify({relay,count:ids.length,manifest},null,2))
  console.error(`registered ${manifest.filter(m=>m.registered).length}/${ids.length}`)
}
main().catch(e=>{console.error("FAIL",e);process.exit(1)})
