import type { ComponentPropsWithoutRef } from "react";

export function Timestamp({
  value,
  locale,
  options = {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  },
  ...props
}: Omit<ComponentPropsWithoutRef<"time">, "dateTime" | "children"> & {
  value: number | Date;
  locale: string;
  options?: Intl.DateTimeFormatOptions;
}) {
  const date = value instanceof Date ? value : new Date(value);
  // Log data can contain invalid dates. Preserve the non-throwing localized
  // fallback rather than letting ISO serialization crash the entire page.
  const dateTime = Number.isFinite(date.getTime()) ? date.toISOString() : undefined;

  return (
    <time dateTime={dateTime} {...props}>
      {date.toLocaleTimeString(locale, options)}
    </time>
  );
}
