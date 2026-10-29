// Prevents an extra console window from popping up on Windows release builds.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

struct OverlayState {
    pinned: AtomicBool,
}

#[tauri::command]
fn set_overlay_pinned(app: tauri::AppHandle, pinned: bool) -> Result<(), String> {
    let window = app.get_webview_window("overlay").ok_or("Overlay window not found")?;
    // Synchronous commands and the maintenance callback run on the window thread.
    window.set_always_on_top(pinned).map_err(|error| error.to_string())?;
    app.state::<OverlayState>().pinned.store(pinned, Ordering::Relaxed);
    Ok(())
}

#[cfg(windows)]
fn maintain_overlay(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindowVisible, SetWindowPos, ShowWindow, HWND_TOPMOST,
        SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    if let Ok(hwnd) = window.hwnd() {
        // Tauri's cached always-on-top flag alone cannot repair Z-order:
        // another topmost window can be inserted above us without changing it.
        // Never activate the overlay or take keyboard focus from the user.
        unsafe {
            if IsIconic(hwnd.0) != 0 || IsWindowVisible(hwnd.0) == 0 {
                ShowWindow(hwnd.0, SW_SHOWNOACTIVATE);
            }
            if SetWindowPos(hwnd.0, HWND_TOPMOST, 0, 0, 0, 0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE) == 0 {
                eprintln!("Cannot restore overlay Z-order: {}", std::io::Error::last_os_error());
            }
        }
    }
}

fn setup_overlay(app: &tauri::AppHandle) -> tauri::Result<()> {
    let overlay = app.get_webview_window("overlay").expect("overlay config must exist");
    let handle = app.clone();
    overlay.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // The hidden player keeps the event loop alive if only this window
            // closes. Exit Tauri so every webview and its browser is cleaned up.
            api.prevent_close();
            handle.state::<OverlayState>().pinned.store(false, Ordering::Relaxed);
            handle.exit(0);
        }
    });
    #[cfg(windows)]
    {
        let handle = app.clone();
        std::thread::Builder::new().name("overlay-visibility".into()).spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(750));
                let Some(window) = handle.get_webview_window("overlay") else { break };
                let app = handle.clone();
                if window.clone().run_on_main_thread(move || {
                    if app.state::<OverlayState>().pinned.load(Ordering::Relaxed) {
                        maintain_overlay(&window);
                    }
                }).is_err() { break; }
            }
        })?;
    }
    Ok(())
}

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
        .manage(OverlayState { pinned: AtomicBool::new(true) })
        .invoke_handler(tauri::generate_handler![ytm_eval, spotify_eval, get_player_state, toggle_music_window, select_player, set_overlay_pinned])
        .setup(|app| {
            setup_overlay(app.handle())?;
            create_player(app.handle(), "ytm", true)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
