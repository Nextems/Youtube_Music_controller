// Prevents an extra console window from popping up on Windows release builds.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};

// Baked into the binary at compile time - no file I/O needed at runtime.
const YTM_WATCHER_JS: &str = include_str!("../scripts/ytm-watcher.js");
const SPOTIFY_WATCHER_JS: &str = include_str!("../scripts/spotify-watcher.js");

#[tauri::command]
fn spotify_eval(app: tauri::AppHandle, script: String) -> Result<(), String> {
    app.get_webview_window("spotify")
        .ok_or("Spotify window not found")?
        .eval(&script).map_err(|e| e.to_string())
}

/// Executes an overlay command in the YouTube Music webview.
#[tauri::command]
fn ytm_eval(app: tauri::AppHandle, script: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.eval(&script).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_player_state(app: tauri::AppHandle) -> Result<(String, bool), String> {
    for (provider, label) in [("ytm", "main"), ("spotify", "spotify")] {
        if let Some(window) = app.get_webview_window(label) {
            let visible = window.is_visible().map_err(|e| e.to_string())?
                && !window.is_minimized().map_err(|e| e.to_string())?;
            return Ok((provider.into(), visible));
        }
    }
    Err("player window not found".into())
}

#[tauri::command]
fn toggle_music_window(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("spotify"))
        .ok_or_else(|| "player window not found".to_string())?;
    let visible = window.is_visible().map_err(|e| e.to_string())?
        && !window.is_minimized().map_err(|e| e.to_string())?;
    if visible {
        window.hide().map_err(|e| e.to_string())?;
        window.set_skip_taskbar(true).map_err(|e| e.to_string())?;
    } else {
        window.set_skip_taskbar(false).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(!visible)
}

#[tauri::command]
async fn select_player(app: tauri::AppHandle, provider: String) -> Result<bool, String> {
    create_player(&app, &provider, false).map_err(|e| e.to_string())
}

fn create_player(app: &tauri::AppHandle, provider: &str, visible: bool) -> tauri::Result<bool> {
    let (label, other, title, url) = match provider {
        "ytm" => ("main", "spotify", "YouTube Music", "https://music.youtube.com"),
        "spotify" => ("spotify", "main", "Spotify", "https://open.spotify.com"),
        _ => return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Unknown player").into()),
    };
    if let Some(window) = app.get_webview_window(label) {
        window.set_skip_taskbar(false)?;
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        return Ok(true);
    }
    let mut config = app.config().app.windows.iter()
        .find(|window| window.label == "main")
        .expect("main player config must exist").clone();
    config.label = label.into();
    config.title = title.into();
    config.url = tauri::WebviewUrl::External(url.parse().expect("valid player URL"));
    config.visible = visible;
    config.skip_taskbar = !visible;
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    if provider == "ytm" {
        builder = builder.initialization_script(YTM_WATCHER_JS);
    } else {
        builder = builder.initialization_script(SPOTIFY_WATCHER_JS);
    }
    let window = builder.build()?;
    if let Some(previous) = app.get_webview_window(other) {
        if let Err(error) = previous.destroy() {
            let _ = window.destroy();
            return Err(error);
        }
    }
    let player = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if player.hide().is_ok() {
                let _ = player.set_skip_taskbar(true);
                let _ = player.emit_to("overlay", "player://visibility", false);
            }
        }
    });
    Ok(visible)
}

fn main() {
    // Both player webviews keep their DOM timers responsive while hidden.
    // WebView2 reads these arguments before the first webview is created.
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
    );

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ytm_eval, spotify_eval, get_player_state, toggle_music_window, select_player])
        .setup(|app| {
            create_player(app.handle(), "ytm", true)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
