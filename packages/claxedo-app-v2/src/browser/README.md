# Browser

Owns: the workspace panel's Browser tab. It previews a URL for the current placement: on the desktop in a `<webview>` driven through the preload's `window.api.browser` bridge, on the web in a sandboxed iframe. It also owns the console and picking an element into the prompt.

## Owned concepts

- **Browser tab** (`tab.ts`): one per placement, created by `BrowserProvider` and kept for the scoped shell's lifetime (at most 4 placements, least recently used first out). It holds the URL, history, console entries (the last 2000) and the current notice, so switching panel tabs keeps them; the page itself reloads when the tab is shown again.
- **Bridge** (`bridge.ts`): the desktop's `window.api.browser`, read once. Without it the tab is the web preview: an iframe with an empty `sandbox`, never same-origin, and no console or picking.
- **Guest page** (`guest.ts`, `view/guest-theme.ts`): the messages the webview's guest preload sends (a hovered element, a submitted pick) and the theme tokens the app sends it.
- **Pick** (`pick-to-composer.ts`): an element the user chose on the page and commented on, with a viewport screenshot. It goes straight into the focused session's composer draft: a text context item with the page URL, selector, snippet and comment, plus the screenshot as an image. A page screenshot from the actions menu goes the same way. With no session in the URL nothing is added, and the notice says to open one.
- **Notice** (`model.ts`): a translated message key, or a bridge's own error text.

## State machines

- **Browser tab** (`model.ts`): `loading(url) → ready(url)`, `ready ↔ picking` (Escape or the pick button stops picking), and `failed(url, reason)` from a failed load or bridge call, with Retry. `moved` updates the URL of an in-page navigation without leaving the state.

## Invariants

- Picks are never stored here; the composer draft is their only home.
- Every bridge call's failure becomes the failed state or a notice, and is logged with its pane id.
- `BrowserProvider` mounts inside the scoped shell and reads the placement from the URL.

## Flows

Flow 27 (preview a local URL, navigate, console, pick an element into the prompt) and flow 33 (phone).
