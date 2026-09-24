# Browser

The Browser panel tab: preview a URL next to the session, navigate, read the page's console, pick an element and send it to the composer.

## Owned concepts

- **Browser tab**: one per placement, kept in `BrowserProvider` (at most 4, least recently used evicted). It owns the URL, the console log, the navigation history, the current element selection and the picks waiting for the composer. It lives across panel-tab switches; the page host (the `<webview>` or the iframe) is recreated on each mount and re-registered with the desktop bridge.
- **Bridge**: the desktop preload's `window.api.browser` (`bridge.ts`). Absent on the web. Every call answers `{ ok, error? }`; a failed navigation becomes the `failed` state, a failed secondary action becomes the tab's notice line.
- **Pick**: an element the user chose on the page and commented on, plus an optional viewport screenshot. `usePickToComposer()` turns picks into `PromptAttachment`s (a text attachment with the page URL, selector, snippet and comment; an image attachment for the screenshot). The composer renders `items()`, calls `remove(id)` on a chip's close and `take()` on send.

## Machine

`BrowserTabState`: `loading(url)` → `ready(url)` → `picking(url)` → `ready(url)`, and `failed(url, reason)` from any state.

Events: `navigate(url)` (a load starts: an address-bar commit, back, forward, reload or the guest's `did-navigate`), `moved(url)` (an in-page hash or history change; keeps `picking`), `loaded(url)` (`dom-ready` or the iframe's `load`; ends `picking`), `startPicking`/`stopPicking` (only from `ready`/`picking`), `failed(reason)` (`did-fail-load` on the main frame, a bridge refusal, a register failure).

## Hosts

- **Desktop**: an Electron `<webview>` on the `persist:agent-browser` partition. On its first `dom-ready` per mount the tab registers its web contents with the bridge, then navigates to the tab's URL (so a URL typed before registration, or one kept from a previous mount, is honoured). Navigation, history and secondary actions go through the bridge, keyed by `browser:<placementId>`. Theme tokens are pushed to the guest preload on `dom-ready` and on every theme change.
- **Web**: a sandboxed `<iframe sandbox="" referrerPolicy="no-referrer">`. Navigation is the iframe's `src`; HTTP pages under an HTTPS app are refused as mixed content. No console, no picking: the controls that need the bridge are disabled and say so.

## Picking

The guest preload's react-grab overlay sends `claxedo-browser-pick` when an element is chosen and `claxedo-browser-comment-submit` when the comment is confirmed, over webview-direct IPC (`ipc-message`). Messages count only while the tab is `picking`, every field is re-validated and size-capped in `guest.ts`, `frameUrl` must share the page's origin, and a submit must name the element picked on the page still on screen. The picker mode is set in the guest with `claxedo-picker:set-mode`. Escape stops picking.

## Data

Nothing here is server data, so there is no `api.ts`: the tab talks to the desktop bridge only. The console log is capped at 2000 entries (the drawer renders the last 100). `store.tsx` is a `.tsx` because the provider is a component.

## Placeholders

`i18n.ts` holds the English dictionary and a local `t` until the shell's i18n provider lands. Plain elements stand in for the kit's buttons and inputs until `src/ui` merges.

## Flows

Flow 27: preview a local URL, navigate, console, pick an element → attached to the prompt (desktop).
