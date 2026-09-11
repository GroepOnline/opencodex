import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";

/** Overlay landmark. Bare div/dialog tags stay inside this primitive. */
export function Modal({
  className = "modal-overlay",
  role = "dialog",
  "aria-modal": ariaModal = true,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={className}
      role={role}
      aria-modal={ariaModal}
      {...props}
    />
  );
}

/** Native dialog overlay. Preserves `dialog.modal-overlay` CSS. */
export function ModalDialog({
  className = "modal-overlay",
  ref,
  ...props
}: ComponentPropsWithoutRef<"dialog"> & { ref?: Ref<HTMLDialogElement> }) {
  return <dialog ref={ref} className={className} {...props} />;
}

export function ModalCard({
  className = "modal-card",
  ref,
  ...props
}: ComponentPropsWithoutRef<"div"> & { ref?: Ref<HTMLDivElement> }) {
  return <div ref={ref} className={className} {...props} />;
}

export function ModalHead({
  titleId,
  title,
  actions,
  className = "modal-head",
}: {
  titleId?: string;
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <h3 id={titleId}>{title}</h3>
      {actions}
    </div>
  );
}

export function ModalDesc({
  className = "modal-desc",
  ...props
}: ComponentPropsWithoutRef<"p">) {
  return <p className={className} {...props} />;
}

export function ModalActions({
  className = "modal-actions",
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={className} {...props} />;
}

export function ModalBackdrop({
  className = "modal-backdrop-dismiss",
  type = "button",
  tabIndex = -1,
  ...props
}: ComponentPropsWithoutRef<"button">) {
  return (
    <button type={type} className={className} tabIndex={tabIndex} {...props} />
  );
}
