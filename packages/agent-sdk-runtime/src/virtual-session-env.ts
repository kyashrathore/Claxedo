import { Bash, InMemoryFs } from "just-bash"
import type { SessionEnv, SessionEnvExecOptions } from "./session-env"

function timeoutSignal(timeoutMs: number | undefined, signal: AbortSignal | undefined) {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} }
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  const timer = setTimeout(() => controller.abort(new Error("command timed out")), timeoutMs)
  if (signal?.aborted) controller.abort(signal.reason)
  signal?.addEventListener("abort", abort, { once: true })
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    },
  }
}

export function createVirtualSessionEnv(input: {
  cwd?: string
  files?: ConstructorParameters<typeof InMemoryFs>[0]
  env?: Record<string, string>
} = {}): SessionEnv {
  const cwd = input.cwd ?? "/"
  const fs = new InMemoryFs(input.files)
  const bash = new Bash({
    cwd,
    fs,
    env: input.env,
    defenseInDepth: true,
  })
  return {
    kind: "virtual",
    cwd() {
      return cwd
    },
    resolvePath(path = ".") {
      return fs.resolvePath(cwd, path)
    },
    async exec(command: string, options?: SessionEnvExecOptions) {
      const abort = timeoutSignal(options?.timeoutMs, options?.signal)
      try {
        const result = await bash.exec(command, {
          cwd: options?.cwd,
          env: options?.env,
          signal: abort.signal,
        })
        if (result.stdout) options?.onStdout?.(result.stdout)
        if (result.stderr) options?.onStderr?.(result.stderr)
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }
      } finally {
        abort.cleanup()
      }
    },
    async readFile(path: string) {
      return fs.readFileBuffer(this.resolvePath(path))
    },
    async writeFile(path: string, content: string | Uint8Array) {
      await fs.writeFile(this.resolvePath(path), content)
    },
    async stat(path: string) {
      const stat = await fs.stat(this.resolvePath(path))
      return {
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymbolicLink,
        size: stat.size,
        mtimeMs: stat.mtime.getTime(),
      }
    },
    async readdir(path = ".") {
      return fs.readdir(this.resolvePath(path))
    },
    exists(path: string) {
      return fs.exists(this.resolvePath(path))
    },
    async mkdir(path: string, options?: { recursive?: boolean }) {
      await fs.mkdir(this.resolvePath(path), options)
    },
    async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
      await fs.rm(this.resolvePath(path), options)
    },
  }
}
