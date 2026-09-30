export const PLUGIN_MAIN_MODULE = "platform.js"
export const PLUGIN_BUNDLE_MODULE = "backend.js"

/**
 * The main module every loaded backend runs under. It re-exports the bundle
 * and gives each declared object class one subclass whose alarm runs only
 * while `env.PLATFORM.active()` says this generation is the organization's
 * current activation, because the runtime delivers a facet's alarm to the
 * facet directly, never through the supervisor. The gate is an own,
 * non-writable property set after the plugin's constructor, so neither a
 * prototype method nor a class field of the plugin's can bypass it, and it
 * captures `env.PLATFORM` before the plugin's constructor can replace it.
 */
export function pluginMainModule(objectClasses: readonly string[]): string {
  const classes = objectClasses.map(
    (name) => `export class ${name} extends backend.${name} {
  constructor(ctx, env) {
    const platform = env.PLATFORM
    super(ctx, env)
    gate(this, platform)
  }
}`,
  )
  return `import * as backend from ${JSON.stringify(`./${PLUGIN_BUNDLE_MODULE}`)}
export default backend.default
function gate(instance, platform) {
  const alarm = instance.alarm
  if (typeof alarm !== "function") return
  Object.defineProperty(instance, "alarm", {
    value: async (info) => ((await platform.active()) ? alarm.call(instance, info) : undefined),
    writable: false,
    configurable: false,
  })
}
${classes.join("\n")}
`
}
