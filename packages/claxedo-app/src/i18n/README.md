# i18n

Owns: the locale (one persisted preference), the locale manifest, and the dictionaries every `t()` reads from.

## API

```ts
import { useTranslator, type Translations } from "@/i18n"
```

Each domain keeps its strings in `src/<domain>/i18n.ts`, one dictionary per language, English required, the other sixteen optional:

```ts
export const dictionary = {
  en: { "rail.newSession": "New session", "rail.search": "Search sessions" },
  de: { "rail.newSession": "Neue Sitzung" },
} satisfies Translations<"rail.newSession" | "rail.search">
```

Keys are prefixed with the domain name so two domains never define the same key. The `one-registration` check fails a key that two dictionaries passed to `useTranslator` or `add` both define; a plugin dictionary is registered at run time, so a duplicate there is logged and the first definition stays.

A component asks for a typed translator for its domain:

```tsx
const t = useTranslator(dictionary)
<button>{t("rail.newSession")}</button>
```

`useTranslator` registers the dictionary with the provider the first time a component of that domain mounts, so nothing else lists dictionaries. Plugins register the same way through the plugin host.

Lookup order: the current locale, then English, then the key itself. A locale's dictionary is built the first time it is read, and a domain registered later folds into the built ones. A translation re-runs when the locale changes or a domain is removed, and, only while its key falls back, when a domain is added, so mounting a new domain never re-runs the labels already on screen. Templates use `{{name}}`: `t("rail.rows", { count: 3 })`.

`useI18n()` gives the locale itself: `locale()`, `setLocale(code)`, `locales` (code, `intlTag` for `Intl`, native label), `intlTag()`, and the untyped `t`.

## Locale

`I18nProvider` sits under the auth provider and above the theme, the router and the server scope in `src/app.tsx`, so the locale survives a sign-in or sign-out that rebuilds the server scope. The locale is detected from `navigator.languages` on first run and persisted under `claxedo:locale`. Changing it sets `<html lang>` to the locale's `intlTag`.

The manifest is `locales.ts`: seventeen codes (`en`, `zh`, `zht`, `ko`, `de`, `es`, `fr`, `da`, `ja`, `pl`, `ru`, `bs`, `ar`, `no`, `br`, `th`, `tr`). `br` is the code the old app persisted for Brazilian Portuguese; its `intlTag` is `pt-BR`. Traditional Chinese is chosen for a `Hant` script tag or a TW, HK or MO region.

## Error copy

`useErrorCopy(surface)` returns `(error: AppError) => { title, message, retry }`: the one table from an error class (`auth`, `forbidden`, `rate_limit`, `network`, `not_found`, `conflict`, `invalid`, `internal`) to what the user reads, in all seventeen locales (`errors/<locale>.ts`). A domain may add copy for its own error codes (such as review's git codes) and fall back to this table for every other failure; the class copy lives only here. Each locale stores typed title/message pairs by error class and three shared actions; `error-copy.ts` produces the translation keys and selects the action once. The first time a hook instance is asked for an error object's copy it records `ui_error_shown` with the class and the caller's surface (startup, connections, organization, terminal, usage, review).

## Flows

Flow 26 switches the language and checks the main screens.
