use machineid_rs::{Encryption, HWIDComponent, IdBuilder};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

use crate::constants::*;

const POLAR_API_BASE: &str = "https://api.polar.sh/v1/customer-portal/license-keys";

fn polar_org_id() -> String {
    option_env!("POLAR_ORG_ID")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("POLAR_ORG_ID").ok())
        .unwrap_or_default()
}

fn generate_hwid() -> Result<String, String> {
    let mut builder = IdBuilder::new(Encryption::SHA256);
    builder
        .add_component(HWIDComponent::SystemID)
        .add_component(HWIDComponent::CPUCores)
        .add_component(HWIDComponent::DriveSerial);
    builder.build("opencode_salt").map_err(|e| format!("Failed to generate HWID: {e}"))
}

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LicenseStatus {
    Activated,
    Unactivated,
}

#[derive(tauri_specta::Event, serde::Deserialize, specta::Type, Clone)]
pub struct LicenseRevoked;

#[tauri::command]
#[specta::specta]
pub async fn validate_license_on_boot(app: AppHandle) -> Result<LicenseStatus, String> {
    // Skip license gate when POLAR_ORG_ID is not configured (dev builds)
    if polar_org_id().is_empty() {
        return Ok(LicenseStatus::Activated);
    }

    let store = app
        .store(LICENSE_STORE)
        .map_err(|e| format!("Failed to open license store: {e}"))?;

    let activation_id = store.get(ACTIVATION_ID_KEY);
    let license_key = store.get(LICENSE_KEY_KEY);
    let stored_hwid = store.get(HWID_KEY);

    let (Some(activation_id), Some(license_key), Some(stored_hwid)) =
        (activation_id, license_key, stored_hwid)
    else {
        return Ok(LicenseStatus::Unactivated);
    };

    let activation_id = activation_id
        .as_str()
        .ok_or("Invalid activation_id in store")?
        .to_string();
    let license_key = license_key
        .as_str()
        .ok_or("Invalid license_key in store")?
        .to_string();
    let stored_hwid = stored_hwid
        .as_str()
        .ok_or("Invalid hwid in store")?
        .to_string();

    // Regenerate HWID and compare
    let current_hwid = generate_hwid()?;
    if current_hwid != stored_hwid {
        tracing::warn!("HWID mismatch — clearing license store");
        store.clear();
        return Ok(LicenseStatus::Unactivated);
    }

    // Boot immediately, validate in background
    let app_clone = app.clone();
    tokio::spawn(async move {
        if let Err(e) = validate_with_polar(&license_key, &activation_id).await {
            tracing::warn!("Background license validation failed: {e}");
            if let Ok(store) = app_clone.store(LICENSE_STORE) {
                let _ = store.clear();
            }
            let _ = app_clone.emit("license-revoked", ());
        }
    });

    Ok(LicenseStatus::Activated)
}

async fn validate_with_polar(key: &str, activation_id: &str) -> Result<(), String> {
    let org_id = polar_org_id();
    let client = reqwest::Client::new();

    let resp = client
        .post(format!("{POLAR_API_BASE}/validate"))
        .json(&json!({
            "key": key,
            "organization_id": org_id,
            "activation_id": activation_id,
        }))
        .send()
        .await
        .map_err(|e| format!("Validation request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Polar validation failed (HTTP {status}): {body}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse validation response: {e}"))?;

    let status = body["status"].as_str().unwrap_or("unknown");
    if status == "revoked" || status == "disabled" {
        return Err(format!("License is {status}"));
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn activate_license(app: AppHandle, key: String) -> Result<(), String> {
    let org_id = polar_org_id();
    if org_id.is_empty() {
        return Err("License activation is not configured".to_string());
    }

    let hwid = generate_hwid()?;
    let client = reqwest::Client::new();

    let resp = client
        .post(format!("{POLAR_API_BASE}/activate"))
        .json(&json!({
            "key": key,
            "organization_id": org_id,
            "label": hwid,
        }))
        .send()
        .await
        .map_err(|e| format!("Activation request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();

        let message = if status.as_u16() == 404 {
            "License key not found".to_string()
        } else if status.as_u16() == 422 {
            // Polar returns 422 for activation limit reached
            parse_polar_error(&body).unwrap_or("Maximum devices reached".to_string())
        } else {
            parse_polar_error(&body)
                .unwrap_or_else(|| format!("Activation failed (HTTP {status})"))
        };

        return Err(message);
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse activation response: {e}"))?;

    let activation_id = body["id"]
        .as_str()
        .ok_or("Missing activation id in response")?;

    let store = app
        .store(LICENSE_STORE)
        .map_err(|e| format!("Failed to open license store: {e}"))?;

    store.set(LICENSE_KEY_KEY, serde_json::Value::String(key));
    store.set(
        ACTIVATION_ID_KEY,
        serde_json::Value::String(activation_id.to_string()),
    );
    store.set(HWID_KEY, serde_json::Value::String(hwid));

    tracing::info!("License activated successfully");
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn deactivate_license(app: AppHandle) -> Result<(), String> {
    let store = app
        .store(LICENSE_STORE)
        .map_err(|e| format!("Failed to open license store: {e}"))?;

    let license_key = store
        .get(LICENSE_KEY_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    let activation_id = store
        .get(ACTIVATION_ID_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));

    let (Some(key), Some(activation_id)) = (license_key, activation_id) else {
        store.clear();
        return Ok(());
    };

    let org_id = polar_org_id();
    let client = reqwest::Client::new();

    let resp = client
        .post(format!("{POLAR_API_BASE}/deactivate"))
        .json(&json!({
            "key": key,
            "organization_id": org_id,
            "activation_id": activation_id,
        }))
        .send()
        .await
        .map_err(|e| format!("Deactivation request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        tracing::warn!("Polar deactivation returned HTTP {status}");
    }

    store.clear();

    tracing::info!("License deactivated");
    Ok(())
}

fn parse_polar_error(body: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    parsed["detail"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| {
            parsed["detail"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|v| v["msg"].as_str())
                .map(|s| s.to_string())
        })
}
