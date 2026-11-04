/** A crucible: the vessel where metal is tested. Two strokes and a drop of amber. */
export function Logo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="assay-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc96b" /><stop offset="1" stopColor="#f2a93b" />
        </linearGradient>
      </defs>
      <path d="M7 6h18l-2.2 14.5A7 7 0 0 1 16 27a7 7 0 0 1-6.8-6.5L7 6z" fill="none" stroke="url(#assay-g)" strokeWidth="2" strokeLinejoin="round" />
      <path d="M10.5 12h11" stroke="url(#assay-g)" strokeWidth="2" strokeLinecap="round" opacity=".8" />
      <circle cx="16" cy="19" r="2.6" fill="url(#assay-g)" />
    </svg>
  );
}
