export function isProjectionCacheKey(key: string) {
  return key.startsWith("projection:workbench:") || key.startsWith("projection:harness-config:")
}
