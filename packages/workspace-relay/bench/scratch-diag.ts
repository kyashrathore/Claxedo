import { Daytona } from "@daytona/sdk"
const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! })
const sb = await daytona.get("37752007-5668-489f-9e9d-aa3d4fbc4298")
for (const cmd of [
  "which bun node python3 || true",
  "cat /tmp/echo.log 2>&1 || echo NOLOG",
  "ls -la /tmp/echo-server.mjs || echo NOFILE",
  "ps aux | grep -i echo | grep -v grep || echo NOPROC",
  "bun --version 2>&1 || echo NOBUN",
]) {
  const r: any = await sb.process.executeCommand(`bash -lc '${cmd}'`)
  console.error(`$ ${cmd}\n${r.result ?? r.stdout ?? JSON.stringify(r)}\n---`)
}
