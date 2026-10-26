import { memo } from "react";
import PlaylistRow from "./PlaylistRow.jsx";
import { useScrollActivity } from "../hooks/useScrollActivity.js";

function PlaylistsPanel({ playlists, loading, onPlay }) {
  const scrollRef = useScrollActivity();

  if (loading) {
    return (
      <p className="text-center text-sm text-slate-500 py-6">
        Loading your playlists…
      </p>
    );
  }

  if (playlists.length === 0) {
    return (
      <p className="text-center text-sm text-slate-500 py-6 px-2">
        No playlists found in the player's sidebar. Open your library in the player to load them.
      </p>
    );
  }

  return (
    // Plain scroll box: no drag-region CSS anywhere near it (see
    // PROJECT_MAP.md 4.8 - window dragging is data-tauri-drag-region now).
    <div
      ref={scrollRef}
      className="max-h-56 overflow-y-auto overscroll-contain queue-scroll flex flex-col gap-1 pr-1"
    >
      {playlists.map((p) => (
        <PlaylistRow key={p.id} playlist={p} onPlay={onPlay} />
      ))}
    </div>
  );
}

export default memo(PlaylistsPanel);
