export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export const PLUGIN_ID_MAX_LENGTH = 64

export function isPluginId(value: string): boolean {
  return value.length <= PLUGIN_ID_MAX_LENGTH && PLUGIN_ID_PATTERN.test(value)
}
