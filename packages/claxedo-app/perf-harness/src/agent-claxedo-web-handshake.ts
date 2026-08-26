const PREFIX = "__CLAXEDO_WEB_ROOT_EVENT__ "

type CommittedRendererEvent = {
  protocolVersion: 1
  type: "renderer-committed"
  url: string
}

export function committedRendererEvent(url: string) {
  return `${PREFIX}${JSON.stringify({ protocolVersion: 1, type: "renderer-committed", url } satisfies CommittedRendererEvent)}`
}

export function createCommittedRendererHandshake(expectedUrl: string) {
  let buffer = ""
  let settled = false
  let resolve!: () => void
  let reject!: (error: Error) => void
  const committed = new Promise<void>((accept, decline) => {
    resolve = accept
    reject = decline
  })

  const fail = (message: string) => {
    if (settled) return
    settled = true
    reject(new Error(message))
  }

  const consume = (line: string) => {
    if (!line.startsWith(PREFIX)) return
    let event: unknown
    try {
      event = JSON.parse(line.slice(PREFIX.length))
    } catch {
      fail("Claxedo web root emitted an invalid committed-renderer event")
      return
    }
    if (!isCommittedRendererEvent(event)) {
      fail("Claxedo web root emitted an unsupported committed-renderer event")
      return
    }
    if (event.url !== expectedUrl) {
      fail(`Claxedo web root committed the wrong renderer URL: ${event.url}`)
      return
    }
    if (settled) return
    settled = true
    resolve()
  }

  const push = (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) consume(line.trimEnd())
    return lines.filter(Boolean)
  }

  const end = () => {
    const tail = buffer
    buffer = ""
    if (tail) consume(tail.trimEnd())
    if (!settled) fail("Claxedo web root exited before committing its renderer")
    return tail ? [tail] : []
  }

  return { committed, push, end }
}

function isCommittedRendererEvent(value: unknown): value is CommittedRendererEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<CommittedRendererEvent>
  return event.protocolVersion === 1 && event.type === "renderer-committed" && typeof event.url === "string"
}
