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
  // toLocaleTimeString rejects date fields (dateStyle, year, …), so date+time
  // readings such as "last scan" fall through to the combined formatter.
  const label = hasDateFields(options)
    ? date.toLocaleString(locale, options)
    : date.toLocaleTimeString(locale, options);

  return (
    <time dateTime={dateTime} {...props}>
      {label}
    </time>
  );
}

const DATE_FIELDS: ReadonlyArray<keyof Intl.DateTimeFormatOptions> = [
  "dateStyle",
  "weekday",
  "era",
  "year",
  "month",
  "day",
];

function hasDateFields(options: Intl.DateTimeFormatOptions): boolean {
  return DATE_FIELDS.some(field => options[field] !== undefined);
}
