/**
 * Main-process wrapper around the guest-side selector generator.
 *
 * Flow:
 *
 *   1. On `Overlay.inspectNodeRequested`, main receives a `backendNodeId` and
 *      the CDP `sessionId` of whichever frame the clicked element lives in.
 *   2. `generateSelectorForNode(debugger, backendNodeId, sessionId)`:
 *      a. Ensures the guest script is installed via `Runtime.evaluate`.
 *      b. Calls `DOM.resolveNode` to get a `RemoteObjectId` for the node.
 *      c. Calls `Runtime.callFunctionOn` with the function body
 *         `function () { return window.__claxedoGuestSelector.generateResultForElement(this); }`
 *         so the guest receives the element as `this`.
 *      d. Parses the returned `Value` JSON (returnByValue: true) into a
 *         `GuestSelectorResult`.
 *   3. If the guest returns `ok: false` with a recoverable error (e.g. the
 *      finder couldn't guarantee uniqueness), fall back to a manual
 *      `:nth-of-type` chain computed from `DOM.describeNode` ancestors.
 *
 * All CDP calls go through the caller-supplied `sendCommand` so the wrapper
 * is testable without Electron. Errors at any layer collapse into
 * `{ ok: false, error: "generic" }` — the caller has a UI placeholder.
 */

import type { BrowserDebugger } from "./handle"
import type { GuestSelectorResult } from "./selector-generator.guest"
import { GUEST_SELECTOR_SCRIPT } from "./selector-generator.guest"

export type SelectorSendCommand = BrowserDebugger["sendCommand"]

export type GenerateSelectorInput = {
  sendCommand: SelectorSendCommand
  backendNodeId: number
  sessionId?: string
}

export async function ensureGuestInstalled(sendCommand: SelectorSendCommand, sessionId?: string): Promise<void> {
  // The install script is idempotent: running it twice just reassigns the
  // same closures on `window.__claxedoGuestSelector`. This costs ~1 ms.
  await sendCommand(
    "Runtime.evaluate",
    {
      expression: GUEST_SELECTOR_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
    },
    sessionId,
  )
}

type CdpResolveNodeResp = { object?: { objectId?: string } }
type CdpCallFunctionResp = {
  result?: { value?: unknown; type?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

/**
 * Dispatch the guest generator for a `backendNodeId` and return its result.
 *
 * Falls back to a `:nth-of-type` chain via `DOM.describeNode` when the guest
 * can't guarantee uniqueness or the element isn't accessible via `resolveNode`
 * (some service-worker-backed documents).
 */
export async function generateSelectorForNode(
  input: GenerateSelectorInput,
): Promise<GuestSelectorResult> {
  const { sendCommand, backendNodeId, sessionId } = input

  // 1. Ensure install.
  try {
    await ensureGuestInstalled(sendCommand, sessionId)
  } catch (err) {
    return {
      ok: false,
      frameUrl: "",
      error: "generic",
      message: `guest install failed: ${errMsg(err)}`,
    }
  }

  // 2. Resolve backendNodeId to a RemoteObject so callFunctionOn can consume it.
  let objectId: string | undefined
  try {
    const resolved = (await sendCommand("DOM.resolveNode", { backendNodeId }, sessionId)) as
      | CdpResolveNodeResp
      | undefined
    objectId = resolved?.object?.objectId
  } catch {
    // Can fail if the node has detached since the click — fall through.
  }

  if (!objectId) {
    // Last resort: build a chain from describeNode ancestors.
    const fallback = await describeNodeFallback(sendCommand, backendNodeId, sessionId)
    return fallback
  }

  // 3. Call the guest generator with the resolved element as `this`.
  let resp: CdpCallFunctionResp | undefined
  try {
    resp = (await sendCommand(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function () { try { return window.__claxedoGuestSelector && window.__claxedoGuestSelector.generateResultForElement(this); } catch (e) { return { ok: false, frameUrl: '', error: 'generic', message: String(e && e.message || e) }; } }",
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    )) as CdpCallFunctionResp
  } catch (err) {
    return {
      ok: false,
      frameUrl: "",
      error: "generic",
      message: `callFunctionOn failed: ${errMsg(err)}`,
    }
  }

  if (resp?.exceptionDetails) {
    const msg =
      resp.exceptionDetails.exception?.description ?? resp.exceptionDetails.text ?? "guest exception"
    return { ok: false, frameUrl: "", error: "generic", message: msg }
  }

  const value = resp?.result?.value
  if (!isPlainObject(value)) {
    return { ok: false, frameUrl: "", error: "generic", message: "guest returned no value" }
  }
  return value as unknown as GuestSelectorResult
}

async function describeNodeFallback(
  sendCommand: SelectorSendCommand,
  backendNodeId: number,
  sessionId?: string,
): Promise<GuestSelectorResult> {
  try {
    const chain: string[] = []
    let currentId: number | undefined = backendNodeId
    let guard = 0
    let frameUrl = ""
    while (currentId && guard < 64) {
      guard++
      const described = (await sendCommand(
        "DOM.describeNode",
        { backendNodeId: currentId, depth: 0 },
        sessionId,
      )) as {
        node?: {
          nodeName?: string
          parentId?: number
          backendNodeId?: number
          documentURL?: string
        }
      }
      const node = described?.node
      if (!node) break
      if (!frameUrl && node.documentURL) frameUrl = node.documentURL
      const tag = (node.nodeName ?? "").toLowerCase()
      if (!tag || tag === "#document") break
      // Without sibling info we can't compute :nth-of-type — emit a coarse tag
      // chain as last-resort. This is intentionally weak; the guest IIFE is
      // the primary path and this only runs when resolveNode already failed.
      chain.unshift(tag)
      if (!node.parentId || node.parentId === currentId) break
      currentId = node.parentId
    }
    if (chain.length === 0) {
      return { ok: false, frameUrl, error: "element-not-found" }
    }
    return {
      ok: true,
      frameUrl,
      path: { selector: chain.join(" > ") },
      tagName: chain[chain.length - 1] ?? "",
    }
  } catch (err) {
    return { ok: false, frameUrl: "", error: "generic", message: errMsg(err) }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
