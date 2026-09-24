import { cn } from "cn";
import { useT } from "../../i18n/shared";

/** Signaal activity mark: a 2px bar that travels once per beat, never a spinner. */
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  const t = useT();
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label={t("common.loading")}
      className={cn("spin busy", className)}
      {...props}
    />
  );
}

export { Spinner };
