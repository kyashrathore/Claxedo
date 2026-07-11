/**
 * Cloud-specific i18n Strings
 *
 * These strings are merged into the core OpenCode dictionaries
 * to provide cloud-specific translations without modifying upstream locale files.
 *
 * Structure: { locale: { "flat.key": "Translation" } }
 *
 * Only keys with a real call site belong here (verified via `grep -rn '"<key>"' src`
 * excluding this file). Everything else is dead weight that silently falls back to
 * English and rots unnoticed.
 */

export const cloudStrings = {
  en: {
    // Override workspace terminology for cloud
    "workspace.new": "New Project",
    "command.project.open": "New Project",

    // Account section
    "settings.general.section.account": "Account",
    "settings.general.account.logout.title": "Log out",
    "settings.general.account.logout.description": "Sign out of your Claxedo account",
    "settings.general.account.logout.button": "Log out",
  },

  zh: {
    // Override workspace terminology for cloud
    "workspace.new": "新建项目",
    "command.project.open": "新建项目",

    // Account section
    "settings.general.section.account": "账户",
    "settings.general.account.logout.title": "退出登录",
    "settings.general.account.logout.description": "退出您的 Claxedo 账户",
    "settings.general.account.logout.button": "退出登录",
  },

  zht: {
    // Override workspace terminology for cloud
    "workspace.new": "新建專案",
    "command.project.open": "新建專案",

    // Account section
    "settings.general.section.account": "帳戶",
    "settings.general.account.logout.title": "登出",
    "settings.general.account.logout.description": "登出您的 Claxedo 帳戶",
    "settings.general.account.logout.button": "登出",
  },

  ja: {
    // Override workspace terminology for cloud
    "workspace.new": "新規プロジェクト",
    "command.project.open": "新規プロジェクト",

    // Account section
    "settings.general.section.account": "アカウント",
    "settings.general.account.logout.title": "ログアウト",
    "settings.general.account.logout.description": "Claxedoアカウントからログアウト",
    "settings.general.account.logout.button": "ログアウト",
  },

  ko: {
    // Override workspace terminology for cloud
    "workspace.new": "새 프로젝트",
    "command.project.open": "새 프로젝트",

    // Account section
    "settings.general.section.account": "계정",
    "settings.general.account.logout.title": "로그아웃",
    "settings.general.account.logout.description": "Claxedo 계정에서 로그아웃",
    "settings.general.account.logout.button": "로그아웃",
  },

  de: {
    // Override workspace terminology for cloud
    "workspace.new": "Neues Projekt",
    "command.project.open": "Neues Projekt",

    // Account section
    "settings.general.section.account": "Konto",
    "settings.general.account.logout.title": "Abmelden",
    "settings.general.account.logout.description": "Von Ihrem Claxedo-Konto abmelden",
    "settings.general.account.logout.button": "Abmelden",
  },

  fr: {
    // Override workspace terminology for cloud
    "workspace.new": "Nouveau projet",
    "command.project.open": "Nouveau projet",

    // Account section
    "settings.general.section.account": "Compte",
    "settings.general.account.logout.title": "Se deconnecter",
    "settings.general.account.logout.description": "Se deconnecter de votre compte Claxedo",
    "settings.general.account.logout.button": "Se deconnecter",
  },

  es: {
    // Override workspace terminology for cloud
    "workspace.new": "Nuevo proyecto",
    "command.project.open": "Nuevo proyecto",

    // Account section
    "settings.general.section.account": "Cuenta",
    "settings.general.account.logout.title": "Cerrar sesion",
    "settings.general.account.logout.description": "Cerrar sesion de su cuenta Claxedo",
    "settings.general.account.logout.button": "Cerrar sesion",
  },
} as const satisfies Record<string, Record<string, string>>

export type CloudStrings = typeof cloudStrings
export type CloudStringKey = keyof (typeof cloudStrings)["en"]
