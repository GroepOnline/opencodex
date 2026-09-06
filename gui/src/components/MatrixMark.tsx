/** A finite, decorative center-out motif inspired by sv-matrix, not a loading state. */
export default function MatrixMark() {
  return (
    <svg
      className="matrix-mark"
      viewBox="0 0 48 48"
      width="48"
      height="48"
      aria-hidden="true"
      focusable="false"
    >
      {Array.from({ length: 25 }, (_, index) => {
        const column = index % 5;
        const row = Math.floor(index / 5);
        const ring = Math.max(Math.abs(column - 2), Math.abs(row - 2));
        return (
          <circle
            key={index}
            cx={4 + column * 10}
            cy={4 + row * 10}
            r="2"
            data-ring={ring}
          />
        );
      })}
    </svg>
  );
}
