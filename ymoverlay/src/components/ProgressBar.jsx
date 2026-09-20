export default function ProgressBar({
  progress,
  elapsed,
  remaining,
  onSeek,
  onSeekCommit,
}) {
  return (
    <div className="w-full">
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={progress}
        // Fires continuously while dragging - updates the visible thumb/time
        // only, does not touch real playback (see usePlaybackState.seek).
        onChange={(e) => onSeek(parseFloat(e.target.value))}
        // Fires once, on release - this is what actually seeks the real
        // player (see usePlaybackState.commitSeek).
        onMouseUp={(e) => onSeekCommit(parseFloat(e.target.value))}
        onTouchEnd={(e) => onSeekCommit(parseFloat(e.target.value))}
        className="w-full h-1 appearance-none rounded-full bg-white/20 accent-white cursor-pointer"
        style={{
          background: `linear-gradient(to right, white ${progress * 100}%, rgba(255,255,255,0.2) ${
            progress * 100
          }%)`,
        }}
      />
      <div className="flex justify-between mt-1.5 text-xs text-slate-400">
        <span>{elapsed}</span>
        <span>{remaining}</span>
      </div>
    </div>
  );
}
