# i18n

Owns: the locale (one persisted preference), the locale manifest, and the dictionaries every `t()` reads from.

## API

```ts
import { useTranslator, type Translations } from "@/i18n"
```

Each domain keeps its strings in `src/<domain>/i18n.ts` (or `i18n/en.ts` with an `i18n/index.ts` beside it), one dictionary per language, English required, the other sixteen optional. A locale's strings are either inline or a loader, `() => import("./locales/de")`, whose module's default export is the strings:

```ts
export const dictionary = {
  en: { "rail.newSession": "New session", "rail.search": "Search sessions" },
  de: () => import("./locales/de"),
} satisfies Translations<"rail.newSession" | "rail.search">
```

The web build groups every `locales/<code>.ts` under `src/` and `src/i18n/errors/<code>.ts` into one `locale-<code>` chunk (`vite.cloud.config.ts`), so a visitor downloads English with the app and exactly one other locale, theirs, in one request. A domain whose strings are a few lines keeps them inline.

A change to an English string's meaning removes that key from every other locale in the same change, so English shows until the string is translated again, and no locale keeps saying what the English no longer says.

Keys are prefixed with the domain name so two domains never define the same key. The `one-registration` check fails a key that two dictionaries passed to `useTranslator` or `add` both define; a plugin dictionary is registered at run time, so a duplicate there is logged and the first definition stays.

A component asks for a typed translator for its domain:

```tsx
const t = useTranslator(dictionary)
<button>{t("rail.newSession")}</button>
```

`useTranslator` registers the dictionary with the provider the first time a component of that domain mounts. The first-party dictionaries are also listed once, in `src/registry.ts` (`firstPartyDictionaries`), so `I18nProvider` can load the current locale's strings for all of them before the shell renders; a plugin dictionary registers at run time through the plugin host and loads its locale when it is added.

Lookup order: the current locale, then English, then the key itself. A locale's dictionary is built the first time it is read, and a domain registered later folds into the built ones. A translation re-runs when the locale changes or a domain is removed, and, only while its key falls back, when a domain is added or a lazily loaded locale lands, so mounting a new domain never re-runs the labels already on screen. Templates use `{{name}}`: `t("rail.rows", { count: 3 })`.

`useI18n()` gives the locale itself: `locale()`, `setLocale(code)`, `locales` (code, `intlTag` for `Intl`, native label), `intlTag()`, `ready()`, and the untyped `t`. `ready()` is false only while the first-party strings of the starting locale are still loading; `src/app.tsx` renders the shell once it is true, so a non-English visitor never sees English labels flash. `setLocale(code)` loads that locale's strings first and switches once they are in, for the same reason. A locale whose chunk fails to load is logged and leaves English showing for the keys it covers.

## Locale

`I18nProvider` sits under the auth provider and above the theme, the router and the server scope in `src/app.tsx`, so the locale survives a sign-in or sign-out that rebuilds the server scope. The locale is detected from `navigator.languages` on first run and persisted under `claxedo:locale`. Changing it sets `<html lang>` to the locale's `intlTag`.

The manifest is `locales.ts`: seventeen codes (`en`, `zh`, `zht`, `ko`, `de`, `es`, `fr`, `da`, `ja`, `pl`, `ru`, `bs`, `ar`, `no`, `br`, `th`, `tr`). `br` is the code the old app persisted for Brazilian Portuguese; its `intlTag` is `pt-BR`. Traditional Chinese is chosen for a `Hant` script tag or a TW, HK or MO region.

## Error copy

`useErrorCopy(surface)` returns `(error: AppError) => { title, message, retry }`: the one table from an error class (`auth`, `forbidden`, `rate_limit`, `network`, `runtime_unreachable`, `not_found`, `conflict`, `invalid`, `internal`) to what the user reads, in all seventeen locales (`errors/<locale>.ts`). A domain may add copy for its own error codes (such as review's git codes) and fall back to this table for every other failure; the class copy lives only here. Each locale stores typed title/message pairs by error class and three shared actions; `error-copy.ts` produces the translation keys and selects the action once. The first time a hook instance is asked for an error object's copy it records `ui_error_shown` with the class and the caller's surface (startup, connections, organization, terminal, usage, review, machines, projects, marketplace, session).

## Flows

Flow 26 switches the language and checks the main screens.
