import type { ReactNode } from "react";

/** Sticky dirty/save bar shared by Grok and Claude Desktop. */
export function ProfileBar({
  dirty,
  status,
  children,
}: {
  dirty: boolean;
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="claude-profile-bar">
      <span className={`claude-dirty${dirty ? " active" : ""}`}>{status}</span>
      <div className="claude-save-actions">{children}</div>
    </div>
  );
}
