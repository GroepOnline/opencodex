import { useEffect, type RefObject } from "react";

/** Interactive descendants that participate in a modal Tab cycle. */
export const MODAL_FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function getModalFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR),
  ).filter(
    (el) =>
      !el.hidden && !el.closest("[disabled], [hidden], [aria-hidden='true']"),
  );
}

/**
 * Modal focus management used by overlay primitives that are not native
 * `<dialog>` / Base UI surfaces: capture the previously focused node, move
 * initial focus inside, keep Tab/Shift+Tab contained, and restore on close.
 */
export function useModalFocus(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusables = () => getModalFocusable(container);
    const initial = focusables()[0] ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const active = document.activeElement;
      const index = list.findIndex((el) => el === active);
      const nextIndex = event.shiftKey
        ? index <= 0
          ? list.length - 1
          : index - 1
        : index === list.length - 1 || index < 0
          ? 0
          : index + 1;
      event.preventDefault();
      list[nextIndex]?.focus();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [containerRef]);
}
