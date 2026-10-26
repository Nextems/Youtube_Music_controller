import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { note } from "./overlayDiag.js";

function command(action, ...args) {
  note(`spotify_eval:${action}`);
  return invoke("spotify_eval", {
    script: `window.__spotifyOverlay?.command(${JSON.stringify(action)}, ${JSON.stringify(args)})`,
  }).catch((error) => emit("spotify://error", String(error)).catch(console.error));
}

export const togglePlay = () => command("togglePlay");
export const next = () => command("next");
export const prev = () => command("prev");
export const skip = (seconds) => command("skip", seconds);
export const seekTo = (seconds) => command("seek", seconds);
export const setVolume = (percent) => command("volume", percent);
export const setQueuePanelOpen = (open) => command("queue", open);
export const setPlaylistsPanelOpen = (open) => command("playlistPanel", open);
export const selectQueueItem = (id) => command("selectTrack", id);
export const fetchPlaylists = () => command("playlists");
export const playPlaylist = (playlist, options) => command("playPlaylist", playlist, options);
export const addQueueItemToPlaylist = (id) => command("addToPlaylist", id);
export const confirmAddToPlaylist = (label) => command("confirmPlaylist", label);
export const cancelAddToPlaylist = () => command("cancelPlaylist");
