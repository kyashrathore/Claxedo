use tauri_plugin_window_state::StateFlags;

pub const SETTINGS_STORE: &str = "opencode.settings.dat";
pub const DEFAULT_SERVER_URL_KEY: &str = "defaultServerUrl";
pub const WSL_ENABLED_KEY: &str = "wslEnabled";
pub const UPDATER_ENABLED: bool = option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some();

// License store
pub const LICENSE_STORE: &str = "opencode.license.dat";
pub const LICENSE_KEY_KEY: &str = "licenseKey";
pub const ACTIVATION_ID_KEY: &str = "activationId";
pub const HWID_KEY: &str = "hwid";

pub fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::DECORATIONS - StateFlags::VISIBLE
}
