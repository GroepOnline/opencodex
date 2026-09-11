import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";

/** Overlay landmark. Bare div/dialog tags stay inside this primitive. */
export function Modal({
  className = "modal-overlay",
  role = "dialog",
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={className}
      role={role}
      aria-modal={props["aria-modal"] ?? true}
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
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={className} {...props} />;
}

export function ModalHead({
  titleId,
  title,
  actions,
  className = "modal-head",
}: {
  titleId: string;
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
