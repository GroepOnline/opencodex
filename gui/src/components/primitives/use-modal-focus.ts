import { useEffect, useEffectEvent, type RefObject } from "react";

export const MODAL_FOCUSABLE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';

function available(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled")) return false;
  for (
    let parent: HTMLElement | null = element;
    parent;
    parent = parent.parentElement
  ) {
    if (
      parent.hidden ||
      parent.inert ||
      parent.getAttribute("aria-hidden") === "true"
    )
      return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(parent);
    if (style?.display === "none" || style?.visibility === "hidden")
      return false;
    if (
      parent.tagName === "DETAILS" &&
      !parent.hasAttribute("open") &&
      !parent.querySelector("summary")?.contains(element)
    )
      return false;
  }
  return true;
}

export function getModalFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR),
  ).filter((element) => element.tabIndex >= 0 && available(element));
}

/** Focus ownership for non-native overlays; native dialogs and nested popups keep their own events. */
export function useModalFocus(
  containerRef: RefObject<HTMLElement | null>,
  options: { onClose?: () => void; suspended?: boolean } = {},
) {
  const suspended = useEffectEvent(() => options.suspended);
  const dismiss = useEffectEvent(() => {
    if (!options.onClose) return false;
    options.onClose();
    return true;
  });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const doc = container.ownerDocument;
    const dialog =
      container.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ??
      container;
    const previous =
      doc.defaultView &&
      doc.activeElement instanceof doc.defaultView.HTMLElement
        ? doc.activeElement
        : null;
    const parents: HTMLElement[] = [];
    for (
      let parent = previous?.parentElement;
      parent;
      parent = parent.parentElement
    )
      parents.push(parent);
    const ownsFocus = () => {
      if (suspended() || doc.querySelector("dialog[open]")) return false;
      const top = [...doc.querySelectorAll('[aria-modal="true"]')].at(-1);
      return !top || top === dialog;
    };
    const controlledPopups = () =>
      [...dialog.querySelectorAll('[aria-expanded="true"][aria-controls]')]
        .flatMap((trigger) =>
          (trigger.getAttribute("aria-controls") ?? "").split(/\s+/),
        )
        .map((id) => doc.getElementById(id))
        .filter((popup) => popup !== null);
    const contains = (element: Element | null) =>
      element !== null &&
      (container.contains(element) ||
        controlledPopups().some((popup) => popup.contains(element)));
    const focusInitial = () =>
      (getModalFocusable(container)[0] ?? container).focus();
    const onFocus = () => {
      if (ownsFocus() && !contains(doc.activeElement)) focusInitial();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !ownsFocus()) return;
      if (event.key === "Escape") {
        if (dismiss()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.key !== "Tab") return;
      if (!container.contains(doc.activeElement) && contains(doc.activeElement))
        return;
      const list = getModalFocusable(container);
      if (list.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const index = list.findIndex((element) => element === doc.activeElement);
      const next = event.shiftKey
        ? index <= 0
          ? list.length - 1
          : index - 1
        : index === list.length - 1 || index < 0
          ? 0
          : index + 1;
      event.preventDefault();
      list[next]?.focus();
    };
    if (ownsFocus()) focusInitial();
    doc.addEventListener("focusin", onFocus);
    doc.addEventListener("keydown", onKeyDown);
    return () => {
      doc.removeEventListener("focusin", onFocus);
      doc.removeEventListener("keydown", onKeyDown);
      if (previous && available(previous)) previous.focus();
      else {
        for (const parent of parents) {
          if (!parent.isConnected) continue;
          const fallback = getModalFocusable(parent).find(
            (element) => !container.contains(element),
          );
          if (fallback) {
            fallback.focus();
            break;
          }
        }
      }
    };
  }, [containerRef]);
}
