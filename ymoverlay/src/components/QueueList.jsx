import { memo } from "react";
import QueueRow from "./QueueRow.jsx";
import { useScrollActivity } from "../hooks/useScrollActivity.js";

// Pure rows - the collapsible open/close wrapper and the toggle button
// live in App.jsx now, shared with the playlists panel (see panelMode).
function QueueList({
  queue,
  onSelect,
  onAddToPlaylist,
  addToPlaylistPrompt,
  onConfirmAddToPlaylist,
  onCancelAddToPlaylist,
}) {
  const scrollRef = useScrollActivity();

  if (queue.length === 0) {
    return (
      <p className="text-center text-sm text-slate-500 py-6">
        Open the queue panel in YouTube Music to see upcoming tracks here.
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
      {queue.map((track) => (
        <QueueRow
          key={track.id}
          track={track}
          onSelect={onSelect}
          onAddToPlaylist={onAddToPlaylist}
          prompt={
            addToPlaylistPrompt && String(addToPlaylistPrompt.index) === track.id
              ? addToPlaylistPrompt
              : null
          }
          onConfirmAddToPlaylist={onConfirmAddToPlaylist}
          onCancelAddToPlaylist={onCancelAddToPlaylist}
        />
      ))}
    </div>
  );
}

// Memoized so this whole list (and its rows) skips re-rendering when
// unrelated state elsewhere in the app changes (e.g. the progress clock
// ticking every ~250ms) - queue/callback props here are already stable
// references (see usePlaybackState.js), so this bails out in the common
// case, which matters most exactly while the user is scrolling.
export default memo(QueueList);
