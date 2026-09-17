import type { ComponentPropsWithoutRef } from "react";

/** Semantic list wrapper for dense operational data. */
export function DataList({ role = "list", ...props }: ComponentPropsWithoutRef<"div">) {
  return <div role={role} {...props} />;
}

/** Semantic row inside a DataList. Product-specific meaning belongs in composites. */
export function DataRow({ role = "listitem", ...props }: ComponentPropsWithoutRef<"div">) {
  return <div role={role} {...props} />;
}
