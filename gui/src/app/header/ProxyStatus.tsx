import { IconAlert, IconCheck } from "../../icons";
import { useT } from "../../i18n/shared";

/** A pending first health check is unknown, never rendered as online. */
export default function ProxyStatus({ online }: { online: boolean | null }) {
  const t = useT();
  if (online === null) return null;
  return (
    <span className={online ? "stamp stamp-ok" : "stamp stamp-err"} role="status">
      {online ? <IconCheck size={13} aria-hidden /> : <IconAlert size={13} aria-hidden />}
      {t(online ? "proxy.online" : "proxy.offline")}
    </span>
  );
}
