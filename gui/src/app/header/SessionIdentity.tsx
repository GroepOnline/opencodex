import { IconUser } from "../../icons";
import { useT } from "../../i18n/shared";

export default function SessionIdentity({ email }: { email: string | null }) {
  const t = useT();
  if (!email) return null;
  return (
    <span
      className="session-identity"
      aria-label={t("session.signedInAs", { email })}
      title={t("session.signedInAs", { email })}
    >
      <IconUser size={15} aria-hidden />
      <span className="session-identity-email">{email}</span>
    </span>
  );
}
