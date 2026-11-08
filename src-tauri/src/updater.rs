use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
struct UpdaterState {
    busy: AtomicBool,
    checked: AtomicBool,
    launched: AtomicBool,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// Both executables use the same OS lock. A crash releases it automatically.
pub fn lock_installation(directory: &Path) -> Result<File> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("installation.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock().map_err(|_| {
        "Close Aurea Code (including the system tray) before updating, then retry.".to_string()
    })?;
    Ok(lock)
}
fn ide_path() -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable
        .parent()
        .ok_or("Unable to locate the application directory.")?;
    Ok(directory.join(if cfg!(windows) {
        "aurea-ide.exe"
    } else {
        "aurea-ide"
    }))
}
fn spawn_ide() -> Result<std::process::Child> {
    Command::new(ide_path()?)
        .env_remove("WEBKIT_INSPECTOR_SERVER")
        .env_remove("WEBKIT_INSPECTOR_HTTP_SERVER")
        .spawn()
        .map_err(|e| format!("Unable to start the installed IDE: {e}"))
}
#[derive(Clone, serde::Serialize)]
struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}
fn progress(app: &tauri::AppHandle, phase: &'static str, downloaded: u64, total: Option<u64>) {
    let _ = app.emit(
        "update-progress",
        Progress {
            phase,
            downloaded,
            total,
        },
    );
}
#[tauri::command]
async fn update_before_launch(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdaterState>,
) -> Result<()> {
    if state.launched.load(Ordering::SeqCst) || state.busy.swap(true, Ordering::SeqCst) {
        return Err("An updater operation is already running.".into());
    }
    let _operation = Operation(&state.busy);
    state.checked.store(true, Ordering::SeqCst);
    progress(&app, "checking", 0, None);
    let directory = app
        .path()
        .data_dir()
        .map_err(|e| e.to_string())?
        .join("dev.aurea.code");
    let installation = lock_installation(&directory)?;
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(mut update) = updater
        .check()
        .await
        .map_err(|e| format!("Unable to check for updates: {e}"))?
    else {
        return Ok(());
    };
    update.timeout = Some(Duration::from_secs(600));
    progress(&app, "downloading", 0, None);
    let mut downloaded = 0;
    let bytes = update
        .download(
            |length, total| {
                downloaded += length as u64;
                progress(&app, "downloading", downloaded, total);
            },
            || progress(&app, "verifying", 0, None),
        )
        .await
        .map_err(|e| format!("Unable to download or verify the update: {e}"))?;
    progress(&app, "installing", 0, None);
    update
        .install(bytes)
        .map_err(|e| format!("Unable to install the update: {e}"))?;
    drop(installation);
    app.restart();
}
#[tauri::command]
fn launch_installed(app: tauri::AppHandle, state: tauri::State<'_, UpdaterState>) -> Result<()> {
    if !state.checked.load(Ordering::SeqCst) || state.busy.swap(true, Ordering::SeqCst) {
        return Err("Wait for the update check to finish.".into());
    }
    let _operation = Operation(&state.busy);
    if state.launched.load(Ordering::SeqCst) {
        return Err("The IDE is already running.".into());
    }
    let mut child = spawn_ide()?;
    state.launched.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("updater") {
        window.hide().map_err(|e| e.to_string())?;
    }
    // Keep the AppImage mount alive while its separately launched IDE uses it.
    std::thread::spawn(move || {
        let outcome = child.wait();
        match outcome {
            Ok(status) if status.success() => app.exit(0),
            _ => {
                app.state::<UpdaterState>()
                    .launched
                    .store(false, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window("updater") {
                    let _ = window.show();
                }
                let _ = app.emit(
                    "launch-error",
                    "The IDE exited unexpectedly. You can try opening it again.",
                );
            }
        }
    });
    Ok(())
}

pub fn run() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "dev.aurea.code.updater".into();
    let window = &mut context.config_mut().app.windows[0];
    window.label = "updater".into();
    window.title = "Aurea Code Updater".into();
    window.url = tauri::WebviewUrl::App("updater.html".into());
    window.width = 460.0;
    window.height = 340.0;
    window.min_width = Some(460.0);
    window.min_height = Some(340.0);
    window.resizable = false;
    window.center = true;
    tauri::Builder::default()
        .manage(UpdaterState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if app.state::<UpdaterState>().launched.load(Ordering::SeqCst) {
                if let Ok(mut child) = spawn_ide() {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                }
            } else if let Some(window) = app.get_webview_window("updater") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<UpdaterState>();
                if state.busy.load(Ordering::SeqCst) || state.launched.load(Ordering::SeqCst) {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            update_before_launch,
            launch_installed
        ])
        .run(context)
        .expect("Unable to start the Aurea updater");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_lock_prevents_updates_while_ide_runs() {
        let directory = tempfile::tempdir().unwrap();
        let ide = lock_installation(directory.path()).unwrap();
        assert!(lock_installation(directory.path()).is_err());
        drop(ide);
        assert!(lock_installation(directory.path()).is_ok());
    }
    #[test]
    fn official_updater_rejects_tampered_payloads_and_mismatched_versions() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), config["plugins"]["updater"].clone());
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        // Keep the signed fixture independent of production signing key rotation.
        let fixture_public_key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDRCOEZCMzNFOUQ5MkE0M0YKUldRL3BKS2RQck9QUy9sMVBvLzZJZmkyditHTlVva29jMjVFSUd6aHRDZ0Z2c1hURWptNFRyVGoK";
        let updater = app
            .updater_builder()
            .pubkey(fixture_public_key)
            .endpoints(vec!["https://example.invalid/latest.json".parse().unwrap()])
            .unwrap()
            .target("linux-x86_64")
            .build()
            .unwrap();
        let manifest = serde_json::json!({
            "version": "9.9.9",
            "platforms": { "linux-x86_64": {
                "url": "https://example.invalid/update.AppImage",
                "signature": include_str!("../../tests/fixtures/update-payload.txt.sig").trim()
            }}
        });
        let update = updater.restore_update(manifest.clone()).unwrap().unwrap();
        let payload = include_bytes!("../../tests/fixtures/update-payload.txt");
        assert!(update.verify(payload).is_ok());
        assert!(update.verify(b"tampered payload").is_err());
        let mut wrong_version = manifest.clone();
        wrong_version["version"] = "9.9.10".into();
        assert!(updater
            .restore_update(wrong_version)
            .unwrap()
            .unwrap()
            .verify(payload)
            .is_err());
        let mut unsigned = manifest;
        unsigned["platforms"]["linux-x86_64"]["signature"] = "".into();
        assert!(updater
            .restore_update(unsigned)
            .unwrap()
            .unwrap()
            .verify(payload)
            .is_err());
    }
}
