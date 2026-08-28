import type { MouseEvent } from "react";
import HeroCanvas from "./HeroCanvas";

/**
 * Landing — public marketing page for OpenCodex.
 *
 * Standalone route, rendered outside the authenticated dashboard shell.
 * One WebGL scene (HeroCanvas) lives behind the hero copy; everything below
 * the fold is flat 2D. Design language: Signaal v3 (one accent, hairlines,
 * Instrument Serif display, General Sans body, JetBrains Mono for data).
 * No i18n keys: this page is English-only by design (public marketing
 * surface, not product UI).
 */

const GITHUB_URL = "https://github.com/GroepOnline/opencodex";
const DOCS_URL = "https://groeponline.github.io/opencodex/";

function landingAnchor(id: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "auto", block: "start" });
  };
}

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
        pathLength={100}
        d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        pathLength={100}
        d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        pathLength={100}
        d="M9.2 15.5c-1.9-1.4-1.9-5.6 0-7 1.5-1.1 4.1-1.1 5.6 0 1.9 1.4 1.9 5.6 0 7-1.5 1.1-4.1 1.1-5.6 0Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* Hero headline as word-level split text (Signaal §16): each word rises out
   of an overflow-hidden mask, staggered by CSS animation-delay. The h1 keeps
   a plain aria-label so assistive tech reads one sentence. */
const H1_WORDS: Array<{ t: string; accent?: boolean; breakAfter?: boolean }> = [
  { t: "Code" },
  { t: "that" },
  { t: "ships.", accent: true, breakAfter: true },
  { t: "Not" },
  { t: "slides." },
];

function HeroTitle() {
  return (
    <h1 className="lp-h1" aria-label="Code that ships. Not slides.">
      {H1_WORDS.map((w, i) => (
        <span key={w.t}>
          <span className="lp-w" aria-hidden="true">
            <span
              className={w.accent ? "lp-wi lp-h1__accent" : "lp-wi"}
              style={{ animationDelay: `${140 + i * 75}ms` }}
            >
              {w.t}
            </span>
          </span>
          {w.breakAfter ? <br /> : null}
        </span>
      ))}
    </h1>
  );
}

function SectionEyebrow({ index, children }: { index: string; children: string }) {
  return (
    <p className="lp-section__eyebrow">
      <span className="lp-section__index">{index}</span>
      {children}
      <span className="lp-section__rule" aria-hidden="true" />
    </p>
  );
}

export default function Landing() {
  return (
    <div className="lp">
      {/* ── Sticky nav ── */}
      <header className="lp-nav">
        <a className="lp-nav__brand" href="#top" onClick={landingAnchor("top")} aria-label="OpenCodex home">
          <Mark />
          <span className="lp-nav__name">OpenCodex</span>
        </a>
        <nav className="lp-nav__links" aria-label="Primary">
          <a href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
          <a href="#pricing" onClick={landingAnchor("pricing")}>Pricing</a>
          <a href="#signin" onClick={landingAnchor("signin")}>Sign in</a>
          <a className="lp-btn lp-btn--primary lp-btn--sm" href="#get-started" onClick={landingAnchor("get-started")}>
            Start building
          </a>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="lp-hero" id="top">
        <HeroCanvas />
        <div className="lp-hero__inner">
          <p className="lp-eyebrow">
            <span className="lp-eyebrow__tick" aria-hidden="true" />
            Open-source coding agent
          </p>
          <HeroTitle />
          <p className="lp-sub">
            OpenCodex routes Claude, Gemini, Grok, DeepSeek and Ollama through
            one local endpoint, so your Codex CLI, app or SDK talks to every
            model without changing a line.
          </p>
          <div className="lp-cta-row">
            <a className="lp-btn lp-btn--primary" href="#get-started" onClick={landingAnchor("get-started")}>Start building</a>
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

        {/* Instrument readout pinned to the hero edge: real values, mono. */}
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

      {/* ── Features ── */}
      <section className="lp-section" id="features">
        <SectionEyebrow index="01">Why OpenCodex</SectionEyebrow>
        <div className="lp-features">
          <article className="lp-feature lp-reveal">
            <span className="lp-feature__index">/01</span>
            <h2>One endpoint, every provider</h2>
            <p>
              Point Codex at <code>localhost</code> once. Switch between Claude,
              Gemini, Grok, DeepSeek or a local Ollama model from the dashboard.
              No client reconfiguration, no SDK forks.
            </p>
          </article>
          <article className="lp-feature lp-reveal">
            <span className="lp-feature__index">/02</span>
            <h2>Quota-aware routing</h2>
            <p>
              Rate limits and credit balances are tracked per account, live.
              When one key hits a wall, traffic moves to the next eligible
              account before your session stalls.
            </p>
          </article>
          <article className="lp-feature lp-reveal">
            <span className="lp-feature__index">/03</span>
            <h2>Your keys stay home</h2>
            <p>
              The proxy runs as a single Bun process on your machine or fleet.
              Credentials never leave your infrastructure. Request bodies are
              never logged.
            </p>
          </article>
        </div>
      </section>

      {/* ── Terminal strip ── */}
      <section className="lp-section lp-section--term">
        <SectionEyebrow index="02">In the terminal</SectionEyebrow>
        <div className="lp-term lp-reveal">
          <div className="lp-term__bar">
            <span className="lp-term__title">ocx</span>
            <span className="lp-term__meta">session · local</span>
          </div>
          <pre className="lp-term__body"><code>{''}<span className="lp-t-line"><span className="lp-t-prompt">$</span> bun install -g opencodex</span>
<span className="lp-t-line"><span className="lp-t-prompt">$</span> ocx</span>
<span className="lp-t-line lp-t-out">  opencodex 2.7.1 · proxy listening on http://localhost:8317</span>
<span className="lp-t-line lp-t-out">  dashboard  → http://localhost:8317/#dashboard</span>
<span className="lp-t-line lp-t-out">  providers  → 5 connected, 0 exhausted</span>
<span className="lp-t-line"> </span>
<span className="lp-t-line"><span className="lp-t-prompt">$</span> export OPENAI_BASE_URL=http://localhost:8317</span>
<span className="lp-t-line"><span className="lp-t-prompt">$</span> codex "refactor the routing layer"</span>
<span className="lp-t-line lp-t-ok">  ✓ routed via claude-opus-4.6 <span className="lp-t-dim">(quota 82%)</span></span>
<span className="lp-t-line lp-t-ok">  ✓ 14 files changed, tests green</span></code></pre>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="lp-section" id="how">
        <SectionEyebrow index="03">How it works</SectionEyebrow>
        <ol className="lp-steps">
          <li className="lp-step lp-reveal">
            <span className="lp-step__num">01</span>
            <h3>Install and start</h3>
            <p>
              <code>bun install -g opencodex</code>, then <code>ocx</code>. The
              dashboard opens on a local port with the proxy already listening.
            </p>
          </li>
          <li className="lp-step lp-reveal">
            <span className="lp-step__num">02</span>
            <h3>Add your providers</h3>
            <p>
              Sign in with OAuth or paste API keys. OpenCodex validates each
              account and learns its models, limits and latency profile.
            </p>
          </li>
          <li className="lp-step lp-reveal">
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
        <SectionEyebrow index="04">Pricing</SectionEyebrow>
        <div className="lp-pricing">
          <div className="lp-price-card lp-reveal">
            <h2>Free, as in MIT</h2>
            <p className="lp-price-card__amount">
              €0 <span>/ forever</span>
            </p>
            <p>
              The full proxy, dashboard and every provider adapter. Self-hosted,
              no account required, no usage caps from us. Your providers' limits
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
        <h2 className="lp-cta-title">
          Ready when you <em className="lp-h1__accent">are</em>.
        </h2>
        <pre className="lp-install"><code><span className="lp-t-prompt">$ </span>bun install -g opencodex && ocx</code></pre>
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
