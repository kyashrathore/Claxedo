import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { keepStdoutForProtocol } from "../../rpc/protocol-stdout"
import { isRunnerRequest, type RunnerReply, type RunnerRequest } from "./runner-protocol"

type Live = { child: ChildProcess; released: boolean }

const FRAME_BYTES = 64 * 1024


function killTree(pid: number): void {
  if (!(pid > 0)) return
  if (process.platform === "win32") {
    const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
    killer.once("error", () => {})
    return
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL")
      return
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) process.stderr.write(`Pi shell host could not end ${target}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

export class PiRunner {
  private readonly live = new Map<string, Live>()
  private readonly groups = new Set<number>()
  private readonly paused = new Set<Readable>()
  private draining = false

  constructor(private readonly post: (reply: RunnerReply) => boolean = (reply) => process.stdout.write(`${JSON.stringify(reply)}\n`),
    private readonly onDrain: (resume: () => void) => void = (resume) => process.stdout.once("drain", resume)) {}

  receive(request: RunnerRequest): void {
    if (request.kind === "run") return this.run(request)
    if (request.kind === "end") return this.end()
    const entry = this.live.get(request.id)
    if (!entry) return
    if (request.kind === "kill" && typeof entry.child.pid === "number") return killTree(entry.child.pid)
    if (request.kind === "release") {
      entry.released = true
      entry.child.stdout?.destroy()
      entry.child.stderr?.destroy()
    }
  }

  private run(request: Extract<RunnerRequest, { kind: "run" }>): void {
    let child: ChildProcess
    try {
      child = spawn(request.file, request.args, { cwd: request.cwd, env: request.env, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (error) {
      this.post({ kind: "failed", id: request.id, message: error instanceof Error ? error.message : String(error) })
      return
    }
    const entry: Live = { child, released: false }
    this.live.set(request.id, entry)
    child.once("error", (error) => {
      this.live.delete(request.id)
      this.post({ kind: "failed", id: request.id, message: error.message })
    })
    child.once("spawn", () => {
      if (typeof child.pid === "number" && process.platform !== "win32") this.groups.add(child.pid)
      this.post({ kind: "started", id: request.id, pid: child.pid ?? 0 })
    })
    if (child.stdout) this.forward(entry, request.id, child.stdout, "stdout")
    if (child.stderr) this.forward(entry, request.id, child.stderr, "stderr")
    child.once("exit", (code, signal) => this.post({ kind: "exit", id: request.id, code, signal }))
    child.once("close", () => this.live.delete(request.id))
  }

  private forward(entry: Live, id: string, stream: Readable, name: "stdout" | "stderr"): void {
    stream.on("data", (chunk: Buffer) => {
      if (entry.released) return
      let accepted = true
      for (let at = 0; at < chunk.length; at += FRAME_BYTES) {
        accepted = this.post({ kind: "output", id, stream: name, data: chunk.subarray(at, at + FRAME_BYTES).toString("base64") }) && accepted
      }
      if (accepted) return
      stream.pause()
      this.paused.add(stream)
      if (this.draining) return
      this.draining = true
      this.onDrain(() => {
        this.draining = false
        for (const paused of this.paused) paused.resume()
        this.paused.clear()
      })
    })
    stream.once("error", () => {})
  }

  end(): void {
    for (const entry of this.live.values()) if (typeof entry.child.pid === "number") killTree(entry.child.pid)
    for (const group of this.groups) killTree(group)
    this.live.clear()
    this.groups.clear()
    setTimeout(() => process.exit(0), 50)
  }
}

const entry = process.argv[1]
if (import.meta.main || (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url))) {
  const protocolOut = keepStdoutForProtocol()
  const runner = new PiRunner((reply) => protocolOut(`${JSON.stringify(reply)}\n`))
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    if (!line.trim()) return
    const request: unknown = JSON.parse(line)
    if (!isRunnerRequest(request)) throw new Error(`Pi shell host received an invalid request: ${line.slice(0, 120)}`)
    runner.receive(request)
  })
  lines.on("close", () => runner.end())
}
