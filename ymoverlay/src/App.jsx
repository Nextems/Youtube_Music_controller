import { ChevronUp, ChevronDown, ListMusic, Pin, PinOff } from "lucide-react";
import { usePlaybackState, PANEL_TRANSITION_MS } from "./hooks/usePlaybackState.js";
import TransportControls from "./components/TransportControls.jsx";
import ProgressBar from "./components/ProgressBar.jsx";
import QueueList from "./components/QueueList.jsx";
import PlaylistsPanel from "./components/PlaylistsPanel.jsx";

// Matches the fixed max-h-56 (14rem) scroll area used inside QueueList /
// PlaylistsPanel - keeping this one source of truth so the collapsing
// wrapper below always animates to exactly the content's real height.
const PANEL_HEIGHT_PX = 224;

export default function App() {
  const {
    isPlaying,
    progress,
    current,
    volume,
    setVolume,
    queue,
    togglePlay,
    seek,
    commitSeek,
    next,
    prev,
    skipForward15,
    skipBack15,
    selectTrack,
    startAddToPlaylist,
    confirmAddToPlaylist,
    cancelAddToPlaylist,
    addToPlaylistPrompt,
    panelMode,
    toggleQueuePanel,
    togglePlaylistsPanel,
    playlists,
    playlistsLoading,
    playPlaylist,
    isPinned,
    togglePin,
  } = usePlaybackState();

  const panelOpen = panelMode !== "closed";

  return (
    <div data-tauri-drag-region className="relative h-screen w-screen flex items-start justify-center bg-transparent pt-2.5">
      {/* WINDOW DRAGGING = data-tauri-drag-region (a JS mousedown ->
          startDragging), NOT CSS `-webkit-app-region`. The CSS version
          made Chromium track every drag/no-drag rect of the page and hand
          the result to the OS window layer, and mouse-wheel input over
          those regions went through the host window instead of straight
          to the page - which is what queued list scrolling behind
          unrelated work (see PROJECT_MAP.md 4.8). The attribute only
          works on the element that is actually clicked (children do not
          inherit it), so it is repeated on the card, the title text and
          the bottom row below. Needs core:window:allow-start-dragging
          (capabilities/default.json).

          Generous corner drag handles. The card below is almost entirely
          covered by interactive controls, so without these the only
          reliably-draggable area was the ~10px margin around it - hard to
          grab precisely. These sit above everything (z-30) at each true
          window corner, overlapping into the card's empty padding area
          (nothing interactive renders in a card's own corner inset). */}
      <div data-tauri-drag-region className="absolute top-0 left-0 z-30 w-6 h-6 cursor-move" />
      <div data-tauri-drag-region className="absolute top-0 right-0 z-30 w-6 h-6 cursor-move" />
      <div data-tauri-drag-region className="absolute bottom-0 left-0 z-30 w-6 h-6 cursor-move" />
      <div data-tauri-drag-region className="absolute bottom-0 right-0 z-30 w-6 h-6 cursor-move" />
      {/* Full edge strips too, per "top/bottom/left/right" - thin so they
          don't eat into the card's own content hit-area. */}
      <div data-tauri-drag-region className="absolute top-0 inset-x-0 h-2 cursor-move" />
      <div data-tauri-drag-region className="absolute bottom-0 inset-x-0 h-2 cursor-move" />
      <div data-tauri-drag-region className="absolute left-0 inset-y-0 w-2 cursor-move" />
      <div data-tauri-drag-region className="absolute right-0 inset-y-0 w-2 cursor-move" />

      {/* Pin / unpin - toggles the native always-on-top flag (see togglePin
          in usePlaybackState.js), so the window can sit either above or
          below other windows. Sits above the corner drag handles (z-40 vs
          their z-30) and is a normal button (it has no drag attribute, so
          a click here hits the button instead of moving the window). Nudged 10px further in from each edge (18px vs the
          previous 8px/top-2/right-2) so it sits fully inside the window
          chrome instead of clipping against its rounded/transparent edge. */}
      <button
        type="button"
        aria-label={isPinned ? "Unpin window (allow other windows on top)" : "Pin window on top"}
        title={isPinned ? "Unpin" : "Pin on top"}
        onClick={togglePin}
        style={{ top: 18, right: 18 }}
        className={`absolute z-40 p-1 rounded-md transition-colors ${
          isPinned
            ? "text-orange-400 hover:text-orange-300 hover:bg-white/10"
            : "text-slate-500 hover:text-slate-200 hover:bg-white/10"
        }`}
      >
        {isPinned ? <Pin size={15} /> : <PinOff size={15} />}
      </button>

      <div data-tauri-drag-region className="relative w-[340px] rounded-card bg-panel border border-white/10 shadow-2xl shadow-black/50 p-5">
        <TransportControls
          art={current.art}
          isPlaying={isPlaying}
          volume={volume}
          onVolumeChange={setVolume}
          onPrev={prev}
          onNext={next}
          onSkipBack15={skipBack15}
          onSkipForward15={skipForward15}
          onTogglePlay={togglePlay}
        />

        <div data-tauri-drag-region className="text-center mt-4">
          <p data-tauri-drag-region className="text-lg text-white font-medium truncate">{current.title}</p>
          <p data-tauri-drag-region className="text-sm text-slate-400 truncate">{current.artist}</p>
        </div>

        <div className="mt-4">
          <ProgressBar
            progress={progress}
            elapsed={current.elapsed}
            remaining={current.remaining}
            onSeek={seek}
            onSeekCommit={commitSeek}
          />
        </div>

        <div className="h-px bg-white/10 my-4" />

        {/* Collapsible panel - fixed target height (PANEL_HEIGHT_PX), so
            the window resize triggered from usePlaybackState always
            matches what's actually animating here. Content underneath
            switches between the queue and the playlists list depending
            on which corner button was pressed. */}
        <div
          className="overflow-hidden transition-[max-height,opacity] ease-in-out"
          style={{
            maxHeight: panelOpen ? `${PANEL_HEIGHT_PX}px` : "0px",
            opacity: panelOpen ? 1 : 0,
            transitionDuration: `${PANEL_TRANSITION_MS}ms`,
          }}
        >
          {panelMode === "queue" && (
            <QueueList
              queue={queue}
              onSelect={selectTrack}
              onAddToPlaylist={startAddToPlaylist}
              addToPlaylistPrompt={addToPlaylistPrompt}
              onConfirmAddToPlaylist={confirmAddToPlaylist}
              onCancelAddToPlaylist={cancelAddToPlaylist}
            />
          )}
          {panelMode === "playlists" && (
            <PlaylistsPanel
              playlists={playlists}
              loading={playlistsLoading}
              onPlay={playPlaylist}
            />
          )}
        </div>

        {/* Bottom row - each toggle fixed to its own corner as requested:
            playlists on the lower-left, queue on the lower-right. */}
        <div data-tauri-drag-region className="flex items-center justify-between pt-2">
          <button
            type="button"
            aria-label="Toggle playlists"
            onClick={togglePlaylistsPanel}
            className="text-slate-500 hover:text-slate-300 transition-colors"
          >
            <ListMusic size={18} className={panelMode === "playlists" ? "text-white" : ""} />
          </button>

          <button
            type="button"
            aria-label="Toggle queue"
            onClick={toggleQueuePanel}
            className="text-slate-500 hover:text-slate-300 transition-colors"
          >
            {panelMode === "queue" ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
