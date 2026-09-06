import { cn } from "cn";
import { Loader2Icon } from "lucide-react";
import { useT } from "../../i18n/shared";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const t = useT();
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label={t("common.loading")}
      className={cn("size-4 motion-safe:animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
