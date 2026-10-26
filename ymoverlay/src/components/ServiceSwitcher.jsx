export default function ServiceSwitcher({ provider, disabled, onSelect }) {
  return (
    <nav aria-label="Music service" className="absolute left-2.5 top-10 z-40 flex flex-col gap-2">
      {[
        { id: "ytm", label: "YouTube Music", color: "#ff3030" },
        { id: "spotify", label: "Spotify", color: "#1ed760" },
      ].map(({ id, label, color }) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={provider === id}
          disabled={disabled}
          onClick={() => onSelect(id)}
          className={`flex h-16 w-16 items-center justify-center rounded-l-2xl border border-r-0 transition-colors disabled:opacity-50 ${
            provider === id ? "bg-slate-800 border-slate-500" : "bg-[#10131b] border-white/10 hover:bg-slate-800"
          }`}
        >
          <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="15" fill={color} />
            {id === "ytm" ? <>
              <circle cx="16" cy="16" r="10" fill="none" stroke="white" strokeWidth="1.5" />
              <path d="M13 10.5 22 16l-9 5.5Z" fill="white" />
            </> : (
              <g fill="none" stroke="#10131b" strokeWidth="2.4" strokeLinecap="round">
                <path d="M8 12c6-2 12-1 17 2M9 17c5-1.5 10-.5 14 2M10 22c4-1 8-.3 11 1" />
              </g>
            )}
          </svg>
        </button>
      ))}
    </nav>
  );
}
