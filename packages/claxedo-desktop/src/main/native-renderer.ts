import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const maxConcurrent = 2
const maxQueued = 8
let active = 0
const queued: Array<() => void> = []

export function createOneShotNativeRenderer(input: {
  name: string
  path?: string
  args?: string[]
  timeoutMs: number
  maxSourceBytes: number
  maxOutputBytes: number
  serialize?: (source: string) => string
  validate?: (output: string) => boolean
  invalidOutputMessage?: string
}) {
  if (!input.path || !existsSync(input.path)) return

  return (source: string) => {
    if (typeof source !== "string") return Promise.reject(new Error(`${input.name} source must be a string`))
    if (Buffer.byteLength(source) > input.maxSourceBytes) {
      return Promise.reject(new Error(`${input.name} source exceeds the native renderer limit`))
    }

    return schedule(() => new Promise<string>((resolve, reject) => {
      const child = spawn(input.path!, input.args ?? [], { stdio: ["pipe", "pipe", "pipe"] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      const finish = (result: { output: string } | { error: Error }) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if ("error" in result) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
          reject(result.error)
          return
        }
        resolve(result.output)
      }
      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
        finish({ error: new Error(`${input.name} rendering exceeded ${String(input.timeoutMs)} ms`) })
      }, input.timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes <= input.maxOutputBytes) {
          stdout.push(chunk)
          return
        }
        child.kill("SIGKILL")
        finish({ error: new Error(`${input.name} output exceeds the response limit`) })
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes <= 16 * 1024) stderr.push(chunk)
      })
      child.once("error", (error) => finish({ error }))
      child.stdin.once("error", (error) => finish({ error }))
      child.once("close", (code) => {
        if (code !== 0) {
          finish({ error: new Error(Buffer.concat(stderr).toString("utf8").trim() || `${input.name} exited ${String(code)}`) })
          return
        }
        const output = Buffer.concat(stdout).toString("utf8").trim()
        if (input.validate && !input.validate(output)) {
          finish({ error: new Error(input.invalidOutputMessage ?? `${input.name} returned an invalid document`) })
          return
        }
        finish({ output })
      })
      child.stdin.end(input.serialize?.(source) ?? source)
    }))
  }
}

function schedule(run: () => Promise<string>) {
  if (active >= maxConcurrent && queued.length >= maxQueued) {
    return Promise.reject(new Error("Native rich-content renderer queue is full"))
  }
  return new Promise<string>((resolve, reject) => {
    const start = () => {
      active += 1
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          active -= 1
          queued.shift()?.()
        })
    }
    if (active < maxConcurrent) {
      start()
      return
    }
    queued.push(start)
  })
}
