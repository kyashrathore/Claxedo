import childProcess from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import path from "node:path"

const record = path.join(process.env.CLAXEDO_DATA_DIR, "retirement-fault.log")
fs.appendFileSync(record, `loaded ${process.pid}\n`)
const spawn = childProcess.spawn
const kill = process.kill.bind(process)

childProcess.spawn = (command, args, options) => {
  if (process.platform === "win32" && path.basename(command).toLowerCase() === "taskkill.exe" && args.includes("/T")) {
    fs.appendFileSync(record, `taskkill ${args.join(" ")}\n`)
    return spawn(command, args.filter((arg) => arg !== "/T"), options)
  }
  return spawn(command, args, options)
}

process.kill = (pid, signal) => {
  if (process.platform !== "win32" && pid < -1 && (signal === "SIGTERM" || signal === "SIGKILL")) {
    fs.appendFileSync(record, `kill group ${pid} with ${signal}\n`)
    return kill(-pid, signal)
  }
  return kill(pid, signal)
}

syncBuiltinESMExports()
