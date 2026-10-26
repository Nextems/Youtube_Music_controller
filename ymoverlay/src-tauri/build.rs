fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ytm_eval", "spotify_eval", "get_player_state", "toggle_music_window", "select_player",
        ]),
    )).expect("failed to build application permissions")
}
