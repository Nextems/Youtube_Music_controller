// Prevents an extra console window from popping up on Windows release builds.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use tauri::Manager;

// Baked into the binary at compile time - no file I/O needed at runtime.
const YTM_WATCHER_JS: &str = include_str!("../scripts/ytm-watcher.js");

/// Runs an arbitrary JS string inside the hidden "main" (music.youtube.com)
/// window. This is the ONLY custom command Step 2 needs: every action
/// (play/pause, next, prev, seek, skip15) is just a different JS string
/// built on the frontend (see src/lib/ytmBridge.js) and sent through here.
#[tauri::command]
fn ytm_eval(app: tauri::AppHandle, script: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.eval(&script).map_err(|e| e.to_string())
}

fn main() {
    // Chromium/WebView2 throttles timers (setInterval) in windows that
    // aren't focused and are visually occluded - which "main" almost
    // always is, since "overlay" sits alwaysOnTop above it and "main"
    // never takes focus (tauri.conf.json: focus: false). ytm-watcher.js's
    // own timers (the 1s tick, the 200ms playback-drift guard) live
    // inside that same throttled event loop - and critically, so does
    // every ytm_eval() call below, since `window.eval()` has to run on
    // that exact same JS thread. A user action from the overlay can
    // therefore end up queued behind however long the throttle is
    // currently stretching that window's timers to, which is the
    // multi-second "action executes after the stall" symptom - not a
    // rendering/compositor issue (nothing here shows up in a Performance
    // trace of the OVERLAY window, since overlay's own renderer is idle
    // and unaffected; only "main"'s trace/console would show it, via
    // enableDiagnostics()'s timer-drift log with no matching long task).
    // Must be set before Tauri creates any webview - WebView2 only reads
    // this env var once, at its own process init.
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
    );

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ytm_eval])
        .setup(|app| {
            let main_window = app
                .get_webview_window("main")
                .expect("main window must exist (declared in tauri.conf.json)");

            // Inject the watcher once at startup. The watcher script itself
            // polls with setInterval until the player DOM is ready, so it
            // doesn't matter if this runs before music.youtube.com has
            // fully finished loading.
            main_window
                .eval(YTM_WATCHER_JS)
                .expect("failed to inject YTM watcher script");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
