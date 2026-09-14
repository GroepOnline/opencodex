import {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Modal } from "./modal";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex !== -1,
  );
}

function useWorkspaceDialogFocus(
  containerRef: RefObject<HTMLDivElement | null>,
  onDismiss?: () => void,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusInitial = () => {
      const elements = focusableElements(container);
      (elements[0] ?? container).focus();
    };
    const frame = requestAnimationFrame(focusInitial);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss?.();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements(container);
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [containerRef, onDismiss]);
}

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
  onClick,
  onDismiss,
  ...props
}: ComponentPropsWithoutRef<"div"> & { onDismiss?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useWorkspaceDialogFocus(ref, onDismiss);

  return (
    <Modal
      ref={ref}
      className={className}
      role={role}
      tabIndex={-1}
      {...props}
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
