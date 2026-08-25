export default function GlobalLoading() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center" style={{ background: '#050505' }}>
      <div className="relative w-12 h-12 mb-6">
        <span className="absolute inset-0 rounded-full border-2 border-blue-500/20 animate-ping" style={{ animationDuration: '2s' }} />
        <span className="absolute inset-2 rounded-full border-2 border-blue-500/10 animate-ping" style={{ animationDuration: '2s', animationDelay: '0.4s' }} />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-500/80 shadow-[0_0_12px_rgba(59,130,246,0.6)]" />
        </span>
      </div>
      <p className="text-[10px] font-mono font-bold text-zinc-600 tracking-[0.25em] uppercase animate-pulse">
        INITIALIZING...
      </p>
    </div>
  );
}
