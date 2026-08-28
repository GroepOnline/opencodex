/* DotMatrix loader — port of sv-matrix `square-1` Neon Drift to React+CSS.
   Uses CSS custom properties for color and speed; respects reduced-motion. */
import { useId } from "react";

type DotMatrixProps = {
  size?: number;
  dotSize?: number;
  speed?: number;
  color?: string;
  className?: string;
};

const GRID = 5;
const DOTS = GRID * GRID;

export function DotMatrix({
  size = 18,
  dotSize = 3,
  speed = 1,
  color = "var(--accent)",
  className,
}: DotMatrixProps) {
  const id = useId();
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${GRID} ${GRID}`}
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      <defs>
        <radialGradient id={`${id}-grad`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={color} stopOpacity={1} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </radialGradient>
      </defs>
      {Array.from({ length: DOTS }).map((_, i) => {
        const col = i % GRID;
        const row = Math.floor(i / GRID);
        const cx = col + 0.5;
        const cy = row + 0.5;
        const delay = (col * 0.12 + row * 0.18) / speed;
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={dotSize / size}
            fill={`url(#${id}-grad)`}
            opacity={0.35}
            style={{ animation: `dmx-pulse 1.4s ${delay}s ease-in-out infinite` }}
          />
        );
      })}
      <style>{`
        @keyframes dmx-pulse {
          0%, 100% { opacity: 0.25; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          svg[aria-hidden="true"] circle {
            animation: none !important;
            opacity: 0.6;
            transform: none;
          }
        }
      `}</style>
    </svg>
  );
}
