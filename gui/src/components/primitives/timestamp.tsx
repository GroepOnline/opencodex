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

  return (
    <time dateTime={date.toISOString()} {...props}>
      {date.toLocaleTimeString(locale, options)}
    </time>
  );
}
