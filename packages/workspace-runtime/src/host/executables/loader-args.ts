const LOADER_FLAG = /^--(import|loader|experimental-loader|conditions|experimental-[\w-]+)(=|$)/

const MODULE_FLAG = /^--(import|loader|experimental-loader)$/

function resolvedModule(flag: string, value: string): string {
  if (!MODULE_FLAG.test(flag) || /^(\.|\/|file:)/.test(value)) return value
  try { return import.meta.resolve(value) } catch { return value }
}

export function loaderArgs(script: string): string[] {
  if (!script.endsWith(".ts") || process.versions.bun) return []
  const args: string[] = []
  for (let index = 0; index < process.execArgv.length; index++) {
    const flag = process.execArgv[index]
    if (flag === undefined || !LOADER_FLAG.test(flag)) continue
    const equals = flag.indexOf("=")
    if (equals >= 0) {
      const name = flag.slice(0, equals)
      args.push(`${name}=${resolvedModule(name, flag.slice(equals + 1))}`)
      continue
    }
    args.push(flag)
    const value = process.execArgv[index + 1]
    if (value === undefined || value.startsWith("-")) continue
    args.push(resolvedModule(flag, value))
    index++
  }
  return args
}
