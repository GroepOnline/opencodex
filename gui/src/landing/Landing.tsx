import HeroCanvas from "./HeroCanvas";

/**
 * Landing — public marketing page for OpenCodex.
 *
 * Standalone route, rendered outside the authenticated dashboard shell.
 * One WebGL scene (HeroCanvas) lives behind the hero copy; everything below
 * the fold is flat 2D. No i18n keys: this page is English-only by design
 * (public marketing surface, not product UI).
 */

const GITHUB_URL = "https://github.com/GroepOnline/opencodex";
const DOCS_URL = "https://groeponline.github.io/opencodex/";

function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="lp-mark"
    >
      <path
        d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M9.2 15.5c-1.9-1.4-1.9-5.6 0-7 1.5-1.1 4.1-1.1 5.6 0 1.9 1.4 1.9 5.6 0 7-1.5 1.1-4.1 1.1-5.6 0Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TICKER_ITEMS = [
  "claude-opus-4.6",
  "gemini-3.1-pro",
  "grok-4.6",
  "deepseek-v4-flash",
  "ollama / local",
  "gpt-5.6",
  "qwen3-coder",
  "kimi-k3",
  "llama-4-maverick",
  "mistral-large-3",
];

export default function Landing() {
  return (
    <div className="lp">
      {/* ── Sticky nav ── */}
      <header className="lp-nav">
        <a className="lp-nav__brand" href="#top" aria-label="OpenCodex home">
          <Mark />
          <span className="lp-nav__name">OpenCodex</span>
        </a>
        <nav className="lp-nav__links" aria-label="Primary">
          <a href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
          <a href="#pricing">Pricing</a>
          <a href="#signin">Sign in</a>
          <a className="lp-btn lp-btn--primary lp-btn--sm" href="#get-started">
            Start building
          </a>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="lp-hero" id="top">
        <HeroCanvas />
        <div className="lp-hero__inner">
          <p className="lp-eyebrow">
            <span className="lp-eyebrow__pulse" aria-hidden="true" />
            Open-source coding agent
          </p>
          <h1 className="lp-h1">
            Code that <em className="lp-h1__glow">ships</em>.
            <br />
            Not slides.
          </h1>
          <p className="lp-sub">
            OpenCodex routes Claude, Gemini, Grok, DeepSeek and Ollama through
            one local endpoint — so your Codex CLI, app or SDK talks to every
            model without changing a line.
          </p>
          <div className="lp-cta-row">
            <a className="lp-btn lp-btn--primary" href="#get-started">Start building</a>
            <a className="lp-btn lp-btn--ghost" href={GITHUB_URL} target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          </div>
          <p className="lp-proof">
            <span>MIT licensed</span>
            <span className="lp-proof__dot" aria-hidden="true" />
            <span>Runs locally</span>
            <span className="lp-proof__dot" aria-hidden="true" />
            <span>One Bun process</span>
          </p>
        </div>

        {/* Live-instrument readout pinned to the hero edge */}
        <div className="lp-hero__readout" aria-hidden="true">
          <div className="lp-readout-row">
            <span className="lp-readout-key">endpoint</span>
            <span className="lp-readout-val">http://localhost:8317</span>
          </div>
          <div className="lp-readout-row">
            <span className="lp-readout-key">routing</span>
            <span className="lp-readout-val lp-readout-val--ok">quota-aware</span>
          </div>
          <div className="lp-readout-row">
            <span className="lp-readout-key">providers</span>
            <span className="lp-readout-val">claude · gemini · grok · deepseek · ollama</span>
          </div>
        </div>
      </section>

      {/* ── Model ticker ── */}
      <div className="lp-ticker" aria-hidden="true">
        <div className="lp-ticker__track">
          {[...TICKER_ITEMS, ...TICKER_ITEMS].map((m, i) => (
            <span className="lp-ticker__item" key={i}>
              {m}
              <span className="lp-ticker__sep">·</span>
            </span>
          ))}
        </div>
      </div>

      {/* ── Features ── */}
      <section className="lp-section" id="features">
        <p className="lp-section__eyebrow">Why OpenCodex</p>
        <div className="lp-features">
          <article className="lp-feature">
            <span className="lp-feature__index">/01</span>
            <h2>One endpoint, every provider</h2>
            <p>
              Point Codex at <code>localhost</code> once. Switch between Claude,
              Gemini, Grok, DeepSeek or a local Ollama model from the dashboard —
              no client reconfiguration, no SDK forks.
            </p>
          </article>
          <article className="lp-feature">
            <span className="lp-feature__index">/02</span>
            <h2>Quota-aware routing</h2>
            <p>
              Per-account rate limits and credit balances are tracked live.
              When one key hits a wall, traffic moves to the next eligible
              account before your session stalls.
            </p>
          </article>
          <article className="lp-feature">
            <span className="lp-feature__index">/03</span>
            <h2>Your keys stay home</h2>
            <p>
              The proxy runs as a single Bun process on your machine or fleet.
              Credentials never leave your infrastructure; request bodies are
              never logged.
            </p>
          </article>
        </div>
      </section>

      {/* ── Terminal strip ── */}
      <section className="lp-section lp-section--term">
        <div className="lp-term">
          <div className="lp-term__bar">
            <span className="lp-term__dot" />
            <span className="lp-term__dot" />
            <span className="lp-term__dot" />
            <span className="lp-term__title">terminal</span>
          </div>
          <pre className="lp-term__body"><code>{`$ bun install -g opencodex
$ ocx
  opencodex 2.7.1 — proxy listening on http://localhost:8317
  dashboard  → http://localhost:8317/#dashboard
  providers  → 5 connected, 0 exhausted

$ export OPENAI_BASE_URL=http://localhost:8317
$ codex "refactor the routing layer"
  ✓ routed via claude-opus-4.6 (quota 82%)
  ✓ 14 files changed, tests green`}</code></pre>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="lp-section lp-section--alt" id="how">
        <p className="lp-section__eyebrow">How it works</p>
        <ol className="lp-steps">
          <li className="lp-step">
            <span className="lp-step__num">01</span>
            <h3>Install and start</h3>
            <p>
              <code>bun install -g opencodex</code>, then <code>ocx</code>. The
              dashboard opens on a local port with the proxy already listening.
            </p>
          </li>
          <li className="lp-step">
            <span className="lp-step__num">02</span>
            <h3>Add your providers</h3>
            <p>
              Sign in with OAuth or paste API keys. OpenCodex validates each
              account and learns its models, limits and latency profile.
            </p>
          </li>
          <li className="lp-step">
            <span className="lp-step__num">03</span>
            <h3>Point your tools at it</h3>
            <p>
              Set one base URL in Codex CLI, the desktop app or your SDK.
              Routing, failover and usage accounting happen behind it.
            </p>
          </li>
        </ol>
      </section>

      {/* ── Pricing stub ── */}
      <section className="lp-section" id="pricing">
        <p className="lp-section__eyebrow">Pricing</p>
        <div className="lp-pricing">
          <div className="lp-price-card">
            <h2>Free, as in MIT</h2>
            <p className="lp-price-card__amount">
              €0 <span>/ forever</span>
            </p>
            <p>
              The full proxy, dashboard and every provider adapter. Self-hosted,
              no account required, no usage caps from us — your providers' limits
              are the only limits.
            </p>
            <a className="lp-btn lp-btn--ghost" href={GITHUB_URL} target="_blank" rel="noreferrer">
              Clone the repo
            </a>
          </div>
        </div>
      </section>

      {/* ── Get started / sign-in anchor ── */}
      <section className="lp-section lp-section--cta" id="get-started">
        <h2>Ready when you <em className="lp-h1__glow">are</em>.</h2>
        <pre className="lp-install"><code>bun install -g opencodex && ocx</code></pre>
        <div className="lp-cta-row">
          <a className="lp-btn lp-btn--primary" href={DOCS_URL} target="_blank" rel="noreferrer">
            Read the docs
          </a>
          <a className="lp-btn lp-btn--ghost" id="signin" href="/#dashboard">
            Open the dashboard
          </a>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="lp-footer">
        <div className="lp-footer__brand">
          <Mark size={18} />
          <span>OpenCodex</span>
        </div>
        <nav className="lp-footer__links" aria-label="Footer">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
          <a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT License</a>
        </nav>
        <p className="lp-footer__note">A GroepOnline project.</p>
      </footer>
    </div>
  );
}
