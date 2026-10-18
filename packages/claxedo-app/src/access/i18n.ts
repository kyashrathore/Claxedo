import type { Translations } from "@/i18n"

type AccessKey =
  | "access.org.title"
  | "access.org.description"
  | "access.org.role.owner"
  | "access.org.role.admin"
  | "access.org.role.member"
  | "access.org.you"
  | "access.org.members"
  | "access.org.membersLoading"
  | "access.org.membersFailed"
  | "access.org.unnamed"
  | "access.org.manager"
  | "access.org.loading"
  | "access.org.failed"
  | "access.org.restricted"
  | "access.org.signedOut"
  | "access.org.none"
  | "access.org.checking"
  | "access.org.signIn"
  | "access.org.signInFailed"

export const accessDictionary = {
  en: {
    "access.org.title": "Organization",
    "access.org.description": "The people you work with. Being in an organization gives nobody access to your machines or projects.",
    "access.org.role.owner": "Owner",
    "access.org.role.admin": "Admin",
    "access.org.role.member": "Member",
    "access.org.you": "You",
    "access.org.members": "Members",
    "access.org.membersLoading": "Loading members…",
    "access.org.membersFailed": "Couldn't load the members",
    "access.org.unnamed": "Member without a name",
    "access.org.manager": "As an owner or admin you manage its members and the provider accounts everyone's agents can run on (Settings → Models).",
    "access.org.loading": "Loading your organization…",
    "access.org.failed": "Couldn't load your organization",
    "access.org.restricted": "Only owners and admins can manage the organization.",
    "access.org.signedOut": "Sign in to see your organization.",
    "access.org.none": "You are not in an organization.",
    "access.org.checking": "Checking account…",
    "access.org.signIn": "Sign in",
    "access.org.signInFailed": "Could not sign in",
  },
  ar: () => import("./locales/ar"),
  br: () => import("./locales/br"),
  bs: () => import("./locales/bs"),
  da: () => import("./locales/da"),
  de: () => import("./locales/de"),
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
  ja: () => import("./locales/ja"),
  ko: () => import("./locales/ko"),
  no: () => import("./locales/no"),
  pl: () => import("./locales/pl"),
  ru: () => import("./locales/ru"),
  th: () => import("./locales/th"),
  tr: () => import("./locales/tr"),
  zh: () => import("./locales/zh"),
  zht: () => import("./locales/zht"),
} satisfies Translations<AccessKey>
