import { memo, useState } from "react";
import { MoreHorizontal, Shuffle, ListOrdered } from "lucide-react";

function PlaylistRow({ playlist, onPlay }) {
  const [menuOpen, setMenuOpen] = useState(false);

  function toggleMenu(e) {
    e.stopPropagation();
    setMenuOpen((o) => !o);
  }

  function handlePlay(shuffle) {
    onPlay(playlist, { shuffle });
    setMenuOpen(false);
  }

  return (
    <div className="relative">
      <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] text-white truncate">{playlist.title}</p>
          {playlist.author && (
            <p className="text-sm text-slate-400 truncate">{playlist.author}</p>
          )}
        </div>
        <span
          role="button"
          aria-label="Playlist options"
          onClick={toggleMenu}
          className="p-1 -m-1 rounded hover:bg-white/10 shrink-0"
        >
          <MoreHorizontal size={18} className="text-slate-400" />
        </span>
      </div>

      {menuOpen && (
        <div className="absolute right-2 top-full mt-1 z-20 w-44 rounded-xl bg-[#20242e] border border-white/10 shadow-xl overflow-hidden">
          <button
            type="button"
            onClick={() => handlePlay(true)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-100 hover:bg-white/10 text-left"
          >
            <Shuffle size={14} /> Shuffle
          </button>
          <button
            type="button"
            onClick={() => handlePlay(false)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-100 hover:bg-white/10 text-left"
          >
            <ListOrdered size={14} /> Play sequentially
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(PlaylistRow);
