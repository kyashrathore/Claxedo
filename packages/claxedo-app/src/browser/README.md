# Browser

Owns: the workspace panel's Browser tab, with v1's chrome. It previews a URL for the current placement: on the desktop in a `<webview>` driven through the preload's `window.api.browser` bridge, on the web in a sandboxed iframe. It also owns the console and picking an element into the prompt.

## Owned concepts

- **Browser tab** (`tab.ts`, `tab-cache.ts`): one per placement, created by `BrowserProvider` and kept for the scoped shell's lifetime (at most 4 placements, least recently used first out) or until its placement leaves `server.placements.list()`; a placement never listed there keeps its tab. It holds the URL, history, console entries (the last 2000) and the current notice, so switching panel tabs keeps them. A focus from the panel (a transcript link, "+ > Browser") navigates it once per request (`navigateOnce`).
- **Chrome** (`view/toolbar.tsx`, `view/address-bar.tsx`, `view/toolbar-actions.tsx`, `view/console.tsx`): v1's toolbar portals into the panel's L2 row: "Go back", "Go forward", "Reload", the address bar ("Enter URL or search", read-only without the bridge), "Inspect element" and "Browser options" (Take Screenshot, Open DevTools, Hard Reload, Copy URL, Clear Cookies, Show console). The toolbar, picker shield and console drawer mount only while the Browser tab is active; the page host stays attached while hidden.
- **Bridge** (`bridge.ts`): the desktop's `window.api.browser`, read once. Without it the tab is v1's hosted frame: "Nothing to preview yet." until a URL is handed to it, then the preview document (`/browser-preview.html`, "Browser preview") holding an iframe titled "External source preview" with an empty `sandbox` and no referrer; an http page inside https says "This source requires HTTPS.". The app's own Content-Security-Policy frames only its own origin, so no script in the app's document, and no app plugin, can frame another origin; the preview document has no script of its own, allows framing only loopback pages and https, and `view/web-preview.tsx` writes the source frame into it.
- **Another machine's localhost** (`view/elsewhere-page.tsx`): a loopback URL (`isLoopbackPage`) in the tab of a placement that is not on the serving machine (a cloud workspace, another machine) names a page on that placement's machine, so neither the webview nor the iframe loads it: the tab says so in one line, names the placement, and offers "Open in a new tab". No relay route forwards a placement's ports yet.
- **Guest page** (`guest.ts`, `view/guest-theme.ts`): the messages the webview's guest preload sends (a hovered element, a submitted pick) and the theme tokens the app sends it.
- **Pick** (`pick-to-composer.ts`): an element the user chose on the page and commented on, with a viewport screenshot. It goes into the focused session's composer draft: a text context item with the page URL, selector, snippet and comment, plus the screenshot as an image.
- **Notice** (`model.ts`, `view/toolbar-actions.tsx`): a translated message key with its parameters, or a bridge's own error text, shown as a toast and then cleared.

## State machines

- **Browser tab** (`model.ts`): `loading(url) → ready(url)`, `ready ↔ picking` (Escape or the inspect toggle stops picking), and `failed(url, reason)` from a failed load or navigation. `moved` updates the URL of an in-page navigation without leaving the state.

## Invariants

- Picks are never stored here; the composer draft is their only home.
- Every bridge call's failure becomes the failed state or a notice, and is logged with its pane id.
- The desktop guest starts at `about:blank`. Its bootstrap navigation cannot replace the requested URL or read history before registration succeeds; the first `dom-ready` registers it, then loads the latest requested URL. The page hosts live in the persistent shell panel, outside the center page. Panel-tab, session, workspace, Marketplace and Settings switches keep the guest mounted, including when the workbench page unmounts. Cached pages keep their DOM order when revisited so selecting a workspace never detaches its webview. A hidden guest keeps running, so it is muted until shown again; the mute waits for registration because Electron refuses webview calls before the guest's first `dom-ready`. Closing the Browser tab or deleting its placement disposes its page and state; opening a fifth workspace browser evicts the least recently used one.
- Desktop admission belongs to `claxedo-desktop/src/main/browser/setup.ts`: only a webview whose session is the object returned by Electron's `session.fromPartition("persist:agent-browser")` can register. Electron does not expose a `Session.partition` field.
- `BrowserProvider` mounts inside the scoped shell and reads the placement from the URL.

## Flows

Flow 27 (a local link in a reply opens the Browser tab with the page) and flow 33 (phone).

Flow 27 also runs against Electron for first-open navigation, a second link in an open pane, preservation of the same guest across panel-tab, session, workspace and shell-page switches, and guest disposal on closing the Browser tab. Web and phone checks preserve an edited form field without requesting the page again. `view/webview-events.test.ts` covers bootstrap event ordering, pending link replacement and normal navigation after registration; `tab-cache.test.ts` covers placement deletion and eviction. The browser domain's 1509-line budget includes these colocated tests and active-only browser controls and the retained page hosts in the bounded workspace cache.
