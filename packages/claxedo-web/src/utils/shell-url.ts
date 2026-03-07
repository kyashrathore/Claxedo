const clean = (value: string | undefined) => value?.trim().replace(/\/+$/, "")
let cache: Promise<string> | undefined

export async function shellUrl(dev: boolean) {
  const env = clean(process.env.CLAXEDO_APP_URL) || clean(process.env.PUBLIC_CLAXEDO_APP_URL)
  if (env) return env
  if (!dev) return "https://app.claxedo.com"
  if (cache) return cache

  cache = Promise.all(
    [4444, 4445, 4446, 4447, 4448, 4449].map(async (port) => {
      const url = `http://localhost:${port}`
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(250),
        })
        if (!response.ok) return
        const html = await response.text().catch(() => "")
        if (!html.includes('id="root"')) return
        if (!html.includes('/src/main.tsx')) return
        return url
      } catch {}
    }),
  ).then((list) => list.find(Boolean) || "http://localhost:4444")

  return cache
}
