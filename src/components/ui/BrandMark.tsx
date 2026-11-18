import { Link } from "react-router-dom";

interface BrandMarkProps {
  compact?: boolean;
  light?: boolean;
}

export function BrandMark({ compact = false, light = false }: BrandMarkProps) {
  return (
    <Link className={`brand-mark ${light ? "brand-mark--light" : ""}`} to="/" aria-label="Lizzor home">
      <span className="brand-mark__symbol" aria-hidden="true">
        <svg viewBox="0 0 36 29" focusable="false">
          <path d="M9 1h12L15 20h18l-5 8H1L9 1Z" />
        </svg>
      </span>
      {!compact && <span className="brand-mark__word">lizzor</span>}
    </Link>
  );
}