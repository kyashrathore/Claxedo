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

    // Connected applications
    "settings.general.section.connectedApps": "Connected applications",
    "settings.general.connectedApps.empty": "No application has been given access to your Claxedo account.",
    "settings.general.connectedApps.revoke": "Disconnect",
    "settings.general.connectedApps.revoking": "Disconnecting...",
    "settings.general.connectedApps.unavailable": "Connected applications are unavailable right now.",
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

    // Connected applications
    "settings.general.section.connectedApps": "已连接的应用",
    "settings.general.connectedApps.empty": "还没有应用获得您 Claxedo 账户的访问权限。",
    "settings.general.connectedApps.revoke": "断开连接",
    "settings.general.connectedApps.revoking": "正在断开...",
    "settings.general.connectedApps.unavailable": "暂时无法获取已连接的应用。",
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

    // Connected applications
    "settings.general.section.connectedApps": "已連接的應用程式",
    "settings.general.connectedApps.empty": "尚未有應用程式取得您 Claxedo 帳戶的存取權。",
    "settings.general.connectedApps.revoke": "中斷連接",
    "settings.general.connectedApps.revoking": "正在中斷...",
    "settings.general.connectedApps.unavailable": "暫時無法取得已連接的應用程式。",
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

    // Connected applications
    "settings.general.section.connectedApps": "連携アプリケーション",
    "settings.general.connectedApps.empty": "Claxedoアカウントへのアクセスを許可したアプリケーションはありません。",
    "settings.general.connectedApps.revoke": "連携を解除",
    "settings.general.connectedApps.revoking": "解除しています...",
    "settings.general.connectedApps.unavailable": "接続済みアプリケーションを現在取得できません。",
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

    // Connected applications
    "settings.general.section.connectedApps": "연결된 애플리케이션",
    "settings.general.connectedApps.empty": "Claxedo 계정에 접근 권한을 부여한 애플리케이션이 없습니다.",
    "settings.general.connectedApps.revoke": "연결 해제",
    "settings.general.connectedApps.revoking": "연결 해제 중...",
    "settings.general.connectedApps.unavailable": "연결된 애플리케이션을 지금 불러올 수 없습니다.",
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

    // Connected applications
    "settings.general.section.connectedApps": "Verbundene Anwendungen",
    "settings.general.connectedApps.empty": "Keine Anwendung hat Zugriff auf Ihr Claxedo-Konto erhalten.",
    "settings.general.connectedApps.revoke": "Trennen",
    "settings.general.connectedApps.revoking": "Wird getrennt...",
    "settings.general.connectedApps.unavailable": "Verbundene Anwendungen sind derzeit nicht verfügbar.",
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

    // Connected applications
    "settings.general.section.connectedApps": "Applications connectees",
    "settings.general.connectedApps.empty": "Aucune application n a recu l acces a votre compte Claxedo.",
    "settings.general.connectedApps.revoke": "Deconnecter",
    "settings.general.connectedApps.revoking": "Deconnexion...",
    "settings.general.connectedApps.unavailable": "Les applications connectées sont momentanément indisponibles.",
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

    // Connected applications
    "settings.general.section.connectedApps": "Aplicaciones conectadas",
    "settings.general.connectedApps.empty": "Ninguna aplicacion tiene acceso a su cuenta Claxedo.",
    "settings.general.connectedApps.revoke": "Desconectar",
    "settings.general.connectedApps.revoking": "Desconectando...",
    "settings.general.connectedApps.unavailable": "Las aplicaciones conectadas no están disponibles en este momento.",
  },
} as const satisfies Record<string, Record<string, string>>

export type CloudStrings = typeof cloudStrings
export type CloudStringKey = keyof (typeof cloudStrings)["en"]
