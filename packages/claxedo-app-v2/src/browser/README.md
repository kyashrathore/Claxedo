# Browser

Owns: the workspace panel's Browser tab, with v1's chrome. It previews a URL for the current placement: on the desktop in a `<webview>` driven through the preload's `window.api.browser` bridge, on the web in a sandboxed iframe. It also owns the console and picking an element into the prompt.

## Owned concepts

- **Browser tab** (`tab.ts`): one per placement, created by `BrowserProvider` and kept for the scoped shell's lifetime (at most 4 placements, least recently used first out). It holds the URL, history, console entries (the last 2000) and the current notice, so switching panel tabs keeps them. A focus from the panel (a transcript link, "+ > Browser") navigates it once per request (`navigateOnce`).
- **Chrome** (`view/toolbar.tsx`, `view/address-bar.tsx`, `view/toolbar-actions.tsx`, `view/console.tsx`): v1's toolbar portals into the panel's L2 row: "Go back", "Go forward", "Reload", the address bar ("Enter URL or search", read-only without the bridge), "Inspect element" and "Browser options" (Take Screenshot, Open DevTools, Hard Reload, Copy URL, Clear Cookies, Show console). The console drawer stays mounted while hidden.
- **Bridge** (`bridge.ts`): the desktop's `window.api.browser`, read once. Without it the tab is v1's hosted frame: "Browser tabs are unavailable." until a URL is handed to it, then an iframe titled "External source preview" with an empty `sandbox` and no referrer; an http page inside https says "This source requires HTTPS.".
- **Guest page** (`guest.ts`, `view/guest-theme.ts`): the messages the webview's guest preload sends (a hovered element, a submitted pick) and the theme tokens the app sends it.
- **Pick** (`pick-to-composer.ts`): an element the user chose on the page and commented on, with a viewport screenshot. It goes into the focused session's composer draft: a text context item with the page URL, selector, snippet and comment, plus the screenshot as an image.
- **Notice** (`model.ts`, `view/toolbar-actions.tsx`): a translated message key with its parameters, or a bridge's own error text, shown as a toast and then cleared.

## State machines

- **Browser tab** (`model.ts`): `loading(url) → ready(url)`, `ready ↔ picking` (Escape or the inspect toggle stops picking), and `failed(url, reason)` from a failed load or navigation. `moved` updates the URL of an in-page navigation without leaving the state.

## Invariants

- Picks are never stored here; the composer draft is their only home.
- Every bridge call's failure becomes the failed state or a notice, and is logged with its pane id.
- `BrowserProvider` mounts inside the scoped shell and reads the placement from the URL.

## Flows

Flow 27 (a local link in a reply opens the Browser tab with the page) and flow 33 (phone).
