import type { ReactNode } from "react";
import { Modal, ModalCard } from "../primitives/modal";

export function StorageConfirmDialog({
  labelledBy,
  onDismiss,
  children,
}: {
  labelledBy: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <Modal aria-labelledby={labelledBy} onClick={onDismiss}>
      <ModalCard onClick={(e) => e.stopPropagation()}>{children}</ModalCard>
    </Modal>
  );
}

export function StorageConfirmActions({ children }: { children: ReactNode }) {
  return (
    <div className="dialog-actions" style={{ marginTop: 16 }}>
      {children}
    </div>
  );
}
