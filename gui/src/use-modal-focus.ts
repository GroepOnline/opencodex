import { useEffect, useEffectEvent, useRef } from "react";

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';

function available(element: HTMLElement) {
  if (!element.isConnected || element.matches(":disabled")) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.inert || parent.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parent.tagName === "DETAILS" && !parent.hasAttribute("open") && !parent.querySelector("summary")?.contains(element)) return false;
  }
  return true;
}

/** Non-native callers attach this ref to their existing initial-focus button.
 * Native dialogs and Base UI keep ownership of their own modal lifecycle.
 */
export function useModalFocus({ onClose, suspended = false }: { onClose: () => void; suspended?: boolean }) {
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const dismiss = useEffectEvent(() => onClose());
  const isSuspended = useEffectEvent(() => suspended);

  useEffect(() => {
    const initial = initialFocusRef.current;
    const dialog = initial?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    if (!initial || !dialog) return;
    const doc = dialog.ownerDocument;
    const previous = doc.activeElement instanceof window.HTMLElement ? doc.activeElement : null;
    const returnParents: HTMLElement[] = [];
    for (let parent = previous?.parentElement; parent; parent = parent.parentElement) returnParents.push(parent);

    const ownsFocus = () => {
      if (isSuspended() || doc.querySelector("dialog[open]")) return false;
      const top = [...doc.querySelectorAll('[aria-modal="true"]')].at(-1);
      return !top || top === dialog;
    };
    const controlledPopups = () => [...dialog.querySelectorAll('[aria-expanded="true"][aria-controls]')]
      .flatMap(trigger => (trigger.getAttribute("aria-controls") ?? "").split(/\s+/))
      .map(id => doc.getElementById(id))
      .filter(popup => popup !== null);
    const containsFocus = (element: Element | null) => element !== null &&
      (dialog.contains(element) || controlledPopups().some(popup => popup.contains(element)));
    const tabbable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(element => element.tabIndex >= 0 && available(element));
    const focusInitial = () => {
      if (available(initial)) initial.focus();
      else tabbable()[0]?.focus();
    };
    const onFocus = () => {
      if (ownsFocus() && !containsFocus(doc.activeElement)) focusInitial();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !ownsFocus()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (event.key === "Tab") {
        const elements = tabbable();
        const first = elements[0];
        const last = elements.at(-1);
        if (!containsFocus(doc.activeElement) || (event.shiftKey ? doc.activeElement === first : doc.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };

    if (ownsFocus()) focusInitial();
    doc.addEventListener("focusin", onFocus);
    // Bubble after nested controls have had the chance to consume Escape.
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.removeEventListener("focusin", onFocus);
      doc.removeEventListener("keydown", onKey);
      if (previous && available(previous)) previous.focus();
      else {
        for (const parent of returnParents) {
          if (!parent.isConnected) continue;
          const fallback = [...parent.querySelectorAll<HTMLElement>(FOCUSABLE)]
            .find(element => !dialog.contains(element) && element.tabIndex >= 0 && available(element));
          if (fallback) { fallback.focus(); break; }
        }
      }
    };
  }, []);

  return initialFocusRef;
}
