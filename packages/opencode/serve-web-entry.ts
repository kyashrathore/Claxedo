// Entry point for running opencode server inside AlmostNode (browser runtime).
// Bun global shim is prepended by build-web.ts — do NOT redefine it here.

import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"

;(async () => {
  try {
    console.log("[web-entry] starting init...")
    await Log.init({ print: true, dev: true, level: "INFO" })
    console.log("[web-entry] Log.init done")

    const port = Number(process.env.PORT) || 3000
    const hostname = process.env.HOST || "0.0.0.0"

    // Initialize a project instance for the server
    const projectDir = "/project"
    const fs = require("fs")
    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(projectDir + "/.git", { recursive: true })
    fs.writeFileSync(projectDir + "/.git/HEAD", "ref: refs/heads/main\n")
    fs.mkdirSync(projectDir + "/.git/refs/heads", { recursive: true })
    fs.writeFileSync(projectDir + "/.git/config", "[core]\n\tbare = false\n")
    console.log("[web-entry] project directory created")

    await Instance.provide({
      directory: projectDir,
      init: InstanceBootstrap,
      fn: () => {
        console.log("[web-entry] calling Server.listen on port " + port)
        const server = Server.listen({ port, hostname })
        console.log("[web-entry] server listening on http://" + server.hostname + ":" + server.port)
      },
    })
  } catch (err: any) {
    console.error("[web-entry] FATAL:", err?.message || err)
    console.error("[web-entry] stack:", err?.stack || "no stack")
  }
})()
