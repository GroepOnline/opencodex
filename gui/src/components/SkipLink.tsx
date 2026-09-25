import type { ReactNode } from "react";

export default function SkipLink({
  targetId,
  children,
}: {
  targetId: string;
  children: ReactNode;
}) {
  return (
    <a
      className="skip-link"
      href={`#${targetId}`}
      onClick={(event) => {
        const target =
          event.currentTarget.ownerDocument.getElementById(targetId);
        if (!target) return;
        event.preventDefault();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start", behavior: "instant" });
      }}
    >
      {children}
    </a>
  );
}
