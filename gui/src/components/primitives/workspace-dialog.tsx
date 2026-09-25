import { useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { useModalFocus } from "./use-modal-focus";

/** Provider-workspace overlay. Preserves `.dialog-backdrop` — not `modal-overlay`. */
export function WorkspaceDialogBackdrop({
  className = "dialog-backdrop",
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={className} {...props} />;
}

/** Card inside the workspace overlay. Always stops backdrop dismiss. */
export function WorkspaceDialog({
  className = "dialog",
  role = "alertdialog",
  "aria-modal": ariaModal = true,
  tabIndex = -1,
  onClick,
  onDismiss,
  ...props
}: ComponentPropsWithoutRef<"div"> & { onDismiss?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { onClose: onDismiss });
  return (
    <div
      className={className}
      role={role}
      aria-modal={ariaModal}
      tabIndex={tabIndex}
      {...props}
      ref={ref}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    />
  );
}

export function WorkspaceDialogTitle({
  children,
  ...props
}: ComponentPropsWithoutRef<"h3">) {
  return <h3 {...props}>{children}</h3>;
}

export function WorkspaceDialogBody({
  children,
  ...props
}: ComponentPropsWithoutRef<"p">) {
  return <p {...props}>{children}</p>;
}

export function WorkspaceDialogActions({
  className = "dialog-actions",
  children,
  ...props
}: ComponentPropsWithoutRef<"div"> & { children: ReactNode }) {
  return (
    <div className={className} {...props}>
      {children}
    </div>
  );
}
