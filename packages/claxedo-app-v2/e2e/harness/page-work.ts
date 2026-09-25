import type { Page } from "@playwright/test"

export type PageWork = {
  readonly animationFrames: number
  readonly mutations: Readonly<Record<string, number>>
  readonly added: Readonly<Record<string, number>>
  readonly removed: Readonly<Record<string, number>>
}

export type PageWorkInput = {
  readonly regions?: Readonly<Record<string, string>>
  readonly nodes?: Readonly<Record<string, string>>
}

type ProbeWindow = Window & { __claxedoPageWork?: { read: () => PageWork; stop: () => void } }

export async function watchPageWork(app: Page, input: PageWorkInput = {}): Promise<() => Promise<PageWork>> {
  await app.evaluate(({ regions, nodes }) => {
    const probe = window as ProbeWindow
    probe.__claxedoPageWork?.stop()
    const work = { animationFrames: 0, mutations: {} as Record<string, number>, added: {} as Record<string, number>, removed: {} as Record<string, number> }
    const bump = (counts: Record<string, number>, key: string) => (counts[key] = (counts[key] ?? 0) + 1)
    const regionOf = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement
      if (!element) return "detached"
      return Object.entries(regions).find(([, selector]) => element.closest(selector))?.[0] ?? "elsewhere"
    }
    const matchNodes = (list: NodeList, counts: Record<string, number>) => {
      for (const node of list) {
        if (!(node instanceof Element)) continue
        for (const [name, selector] of Object.entries(nodes)) if (node.matches(selector) || node.querySelector(selector)) bump(counts, name)
      }
    }
    const take = (records: MutationRecord[]) => {
      for (const record of records) {
        bump(work.mutations, regionOf(record.target))
        matchNodes(record.addedNodes, work.added)
        matchNodes(record.removedNodes, work.removed)
      }
    }
    const observer = new MutationObserver(take)
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    const request = window.requestAnimationFrame
    window.requestAnimationFrame = (callback) => {
      work.animationFrames += 1
      return request.call(window, callback)
    }
    probe.__claxedoPageWork = {
      read: () => {
        take(observer.takeRecords())
        return structuredClone(work)
      },
      stop: () => {
        observer.disconnect()
        window.requestAnimationFrame = request
      },
    }
  }, { regions: input.regions ?? {}, nodes: input.nodes ?? {} })
  return () =>
    app.evaluate(() => {
      const probe = (window as ProbeWindow).__claxedoPageWork
      if (!probe) throw new Error("watchPageWork was not started on this page")
      const work = probe.read()
      probe.stop()
      return work
    })
}
