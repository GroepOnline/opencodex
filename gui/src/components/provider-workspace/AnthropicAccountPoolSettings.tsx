import OAuthAccountPoolSettings from "./OAuthAccountPoolSettings";

export default function AnthropicAccountPoolSettings({
  apiBase,
  accountCount,
}: {
  apiBase: string;
  accountCount: number;
}) {
  return <OAuthAccountPoolSettings provider="anthropic" apiBase={apiBase} accountCount={accountCount} />;
}
