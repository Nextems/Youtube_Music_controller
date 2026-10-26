import { memo, useState } from "react";
import { MoreHorizontal, ListPlus } from "lucide-react";

function QueueRow({
  track,
  onSelect,
  onAddToPlaylist,
  prompt,
  onConfirmAddToPlaylist,
  onCancelAddToPlaylist,
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  function toggleMenu(e) {
    e.stopPropagation();
    setMenuOpen((o) => !o);
  }

  function handleAddToPlaylist(e) {
    e.stopPropagation();
    onAddToPlaylist(track.id);
    setMenuOpen(false);
  }

  return (
    <div className="relative">
      <div
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left ${
          track.active ? "bg-row" : ""
        }`}
      >
        <button type="button" onClick={() => onSelect(track.id)} className="min-w-0 flex flex-1 items-center gap-3 text-left">
        {track.art && <img src={track.art} alt="" className="h-10 w-10 rounded-md object-cover shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] text-white truncate">{track.title}</p>
          <p className="text-sm text-slate-400 truncate">{track.artist}</p>
        </div>
        </button>
        <button
          type="button"
          aria-label="Track options"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
          className="p-1 -m-1 rounded hover:bg-white/10 shrink-0"
        >
          <MoreHorizontal size={18} className="text-slate-400" />
        </button>
      </div>

      {menuOpen && (
        <div className="relative ml-auto mr-2 mb-1 w-44 rounded-xl bg-[#20242e] border border-white/10 shadow-xl overflow-hidden">
          <button
            type="button"
            onClick={handleAddToPlaylist}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-100 hover:bg-white/10 text-left"
          >
            <ListPlus size={14} /> Add to Playlist
          </button>
        </div>
      )}

      {prompt && (
        <div className="fixed right-5 top-1/2 -translate-y-1/2 z-50 w-48 max-h-48 overflow-y-auto queue-scroll rounded-xl bg-[#20242e] border border-white/10 shadow-xl p-1">
          {prompt.loading && (
            <p className="px-3 py-2 text-xs text-slate-400">Loading playlists…</p>
          )}
          {!prompt.loading && prompt.options.length === 0 && (
            <p className="px-3 py-2 text-xs text-slate-400">No playlists found</p>
          )}
          {prompt.options.map((opt, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onConfirmAddToPlaylist(opt.id ?? opt.label)}
              className="w-full text-left px-3 py-2 text-sm text-slate-100 hover:bg-white/10 rounded-lg truncate"
            >
              {opt.label}
              {opt.subtitle && <span className="block text-xs text-slate-400 truncate">{opt.subtitle}</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={onCancelAddToPlaylist}
            className="w-full text-left px-3 py-2 text-xs text-slate-500 hover:bg-white/10 rounded-lg"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(QueueRow);
