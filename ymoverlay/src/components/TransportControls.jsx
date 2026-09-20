import { useState } from "react";
import { SkipBack, SkipForward, RotateCcw, RotateCw, Play, Pause, Volume2 } from "lucide-react";

function IconButton({ children, onClick, label }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="text-slate-200 hover:text-white active:scale-90 transition-transform"
    >
      {children}
    </button>
  );
}

export default function TransportControls({
  art,
  isPlaying,
  volume,
  onVolumeChange,
  onPrev,
  onNext,
  onSkipBack15,
  onSkipForward15,
  onTogglePlay,
}) {
  const [hovering, setHovering] = useState(false);

  return (
    <div className="flex items-center justify-between px-2">
      <IconButton label="Previous track" onClick={onPrev}>
        <SkipBack size={22} fill="currentColor" />
      </IconButton>

      {/* This wrapper is the hover zone AND the exact width the volume
          slider overlays - it spans from the rewind button to the
          fast-forward button, matching the requested layout. */}
      <div
        className="relative flex items-center gap-4"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <IconButton label="Back 15 seconds" onClick={onSkipBack15}>
          <div className="relative">
            <RotateCcw size={26} strokeWidth={1.5} />
            <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold">
              15
            </span>
          </div>
        </IconButton>

        {/* Album art doubles as the play/pause hit-target. */}
        <button
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={onTogglePlay}
          className="group relative w-20 h-20 rounded-2xl overflow-hidden shadow-lg shadow-black/40 shrink-0"
        >
          <img
            src={art}
            alt=""
            loading="eager"
            decoding="async"
            draggable={false}
            className="w-full h-full object-cover"
          />
          <span className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center transition-colors">
            {isPlaying ? (
              <Pause className="opacity-0 group-hover:opacity-100 text-white transition-opacity" size={28} />
            ) : (
              <Play className="opacity-0 group-hover:opacity-100 text-white transition-opacity" size={28} />
            )}
          </span>
        </button>

        <IconButton label="Forward 15 seconds" onClick={onSkipForward15}>
          <div className="relative">
            <RotateCw size={26} strokeWidth={1.5} />
            <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold">
              15
            </span>
          </div>
        </IconButton>

        {/* Volume overlay - floats ABOVE the cluster on hover, rather than
            covering the art. Positioned with bottom-full so it never
            affects the row's own layout/coordinates below it.

            The outer bridge div below is ALWAYS pointer-events-auto and
            sits flush against the row (bottom-full = 0 gap), with the
            visual gap to the pill expressed as pb-2 PADDING rather than
            a margin. Padding is still inside the element's hit-box, so
            the mouse never crosses a dead pixel between the row and the
            pill - margin would sit outside the box and silently break
            hover the instant the cursor entered that space. Only the
            inner pill fades/toggles pointer-events, since that's the
            only part that should actually block clicks when hidden. */}
        <div className="absolute inset-x-0 bottom-full flex items-end justify-center pb-2">
          <div
            className={`w-full flex items-center gap-2 rounded-full bg-black/80 px-4 py-1.5 shadow-lg shadow-black/40 transition-opacity duration-300 ${
              hovering ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            }`}
          >
            <Volume2 size={16} className="text-slate-200 shrink-0" />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume}
              onChange={(e) => onVolumeChange(parseInt(e.target.value, 10))}
              className="w-full h-1 appearance-none rounded-full bg-white/20 accent-white cursor-pointer"
              style={{
                background: `linear-gradient(to right, white ${volume}%, rgba(255,255,255,0.25) ${volume}%)`,
              }}
            />
          </div>
        </div>
      </div>

      <IconButton label="Next track" onClick={onNext}>
        <SkipForward size={22} fill="currentColor" />
      </IconButton>
    </div>
  );
}
