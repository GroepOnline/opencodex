import type { MouseEvent } from "react";
import { useT } from "../i18n/shared";
import HeroCanvas from "./HeroCanvas";

/**
 * Landing — public marketing page for OpenCodex.
 *
 * Standalone route, rendered outside the authenticated dashboard shell.
 * One WebGL scene (HeroCanvas) lives behind the hero copy; everything below
 * the fold is flat 2D. Design language: Signaal v3 (one accent, hairlines,
 * Instrument Serif display, General Sans body, JetBrains Mono for data).
 * Public copy follows the same EN/NL locale contract as the product UI.
 */

const GITHUB_URL = "https://github.com/GroepOnline/opencodex";
const DOCS_URL = "https://groeponline.github.io/opencodex/";

function landingAnchor(id: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "auto", block: "start" });
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
function HeroTitle() {
  const t = useT();
  const prefix = t("landing.hero.titlePrefix");
  const accent = t("landing.hero.titleAccent");
  const suffix = t("landing.hero.titleSuffix");
  const words: Array<{ t: string; accent?: boolean; breakAfter?: boolean }> = [
    ...prefix.split(" ").map((word) => ({ t: word })),
    { t: accent, accent: true, breakAfter: true },
    ...suffix.split(" ").map((word) => ({ t: word })),
  ];

  return (
    <h1 className="lp-h1" aria-label={`${prefix} ${accent} ${suffix}`}>
      {words.map((w, i) => (
        <span key={`${i}:${w.t}`}>
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

function SectionEyebrow({
  index,
  children,
}: {
  index: string;
  children: string;
}) {
  return (
    <p className="lp-section__eyebrow">
      <span className="lp-section__index">{index}</span>
      {children}
      <span className="lp-section__rule" aria-hidden="true" />
    </p>
  );
}

export default function Landing() {
  const t = useT();

  return (
    <div className="lp">
      {/* ── Sticky nav ── */}
      <header className="lp-nav">
        <a
          className="lp-nav__brand"
          href="#top"
          onClick={landingAnchor("top")}
          aria-label={t("landing.nav.homeAria")}
        >
          <Mark />
          <span className="lp-nav__name">OpenCodex</span>
        </a>
        <nav
          className="lp-nav__links"
          aria-label={t("landing.nav.primaryAria")}
        >
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            {t("landing.nav.docs")}
          </a>
          <a href="#pricing" onClick={landingAnchor("pricing")}>
            {t("landing.nav.pricing")}
          </a>
          <a href="#signin" onClick={landingAnchor("signin")}>
            {t("landing.nav.signIn")}
          </a>
          <a
            className="lp-btn lp-btn--primary lp-btn--sm"
            href="#get-started"
            onClick={landingAnchor("get-started")}
          >
            {t("landing.nav.start")}
          </a>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="lp-hero" id="top">
        <HeroCanvas />
        <div className="lp-hero__inner">
          <p className="lp-eyebrow">
            <span className="lp-eyebrow__tick" aria-hidden="true" />
            {t("landing.hero.eyebrow")}
          </p>
          <HeroTitle />
          <p className="lp-sub">{t("landing.hero.sub")}</p>
          <div className="lp-cta-row">
            <a
              className="lp-btn lp-btn--primary"
              href="#get-started"
              onClick={landingAnchor("get-started")}
            >
              {t("landing.nav.start")}
            </a>
            <a
              className="lp-btn lp-btn--ghost"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("landing.hero.github")}
            </a>
          </div>
          <p className="lp-proof">
            <span>{t("landing.hero.proofLicense")}</span>
            <span className="lp-proof__dot" aria-hidden="true" />
            <span>{t("landing.hero.proofLocal")}</span>
            <span className="lp-proof__dot" aria-hidden="true" />
            <span>{t("landing.hero.proofProcess")}</span>
          </p>
        </div>

        {/* Instrument readout pinned to the hero edge: real values, mono. */}
        <div className="lp-hero__readout" aria-hidden="true">
          <div className="lp-readout-row">
            <span className="lp-readout-key">
              {t("landing.readout.endpoint")}
            </span>
            <span className="lp-readout-val">http://localhost:8317</span>
          </div>
          <div className="lp-readout-row">
            <span className="lp-readout-key">
              {t("landing.readout.routing")}
            </span>
            <span className="lp-readout-val lp-readout-val--ok">
              {t("landing.readout.quotaAware")}
            </span>
          </div>
          <div className="lp-readout-row">
            <span className="lp-readout-key">
              {t("landing.readout.providers")}
            </span>
            <span className="lp-readout-val">
              claude · gemini · grok · deepseek · ollama
            </span>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="lp-section" id="features">
        <SectionEyebrow index="01">
          {t("landing.features.eyebrow")}
        </SectionEyebrow>
        <div className="lp-features">
          <article className="lp-feature lp-reveal">
            <span className="lp-feature__index">/01</span>
            <h2>{t("landing.features.oneTitle")}</h2>
            <p>{t("landing.features.oneBody")}</p>
          </article>
          <article className="lp-feature lp-reveal">
            <span className="lp-feature__index">/02</span>
            <h2>{t("landing.features.twoTitle")}</h2>
            <p>{t("landing.features.twoBody")}</p>
          </article>
          <article className="lp-feature lp-reveal">
            <span className="lp-feature__index">/03</span>
            <h2>{t("landing.features.threeTitle")}</h2>
            <p>{t("landing.features.threeBody")}</p>
          </article>
        </div>
      </section>

      {/* ── Terminal strip ── */}
      <section className="lp-section lp-section--term">
        <SectionEyebrow index="02">
          {t("landing.terminal.eyebrow")}
        </SectionEyebrow>
        <div className="lp-term lp-reveal">
          <div className="lp-term__bar">
            <span className="lp-term__title">ocx</span>
            <span className="lp-term__meta">{t("landing.terminal.meta")}</span>
          </div>
          <pre className="lp-term__body">
            <code>
              {""}
              <span className="lp-t-line">
                <span className="lp-t-prompt">$</span> bun install -g opencodex
              </span>
              <span className="lp-t-line">
                <span className="lp-t-prompt">$</span> ocx
              </span>
              <span className="lp-t-line lp-t-out">
                {" "}
                {t("landing.terminal.proxyListening", {
                  version: __APP_VERSION__,
                })}
              </span>
              <span className="lp-t-line lp-t-out">
                {" "}
                {t("landing.terminal.dashboard")}
              </span>
              <span className="lp-t-line lp-t-out">
                {" "}
                {t("landing.terminal.providers")}
              </span>
              <span className="lp-t-line"> </span>
              <span className="lp-t-line">
                <span className="lp-t-prompt">$</span> export
                OPENAI_BASE_URL=http://localhost:8317
              </span>
              <span className="lp-t-line">
                <span className="lp-t-prompt">$</span> codex "
                {t("landing.terminal.prompt")}"
              </span>
              <span className="lp-t-line lp-t-ok">
                {" "}
                {t("landing.terminal.routed", {
                  model: "claude-opus-4.6",
                  quota: 82,
                })}
              </span>
              <span className="lp-t-line lp-t-ok">
                {" "}
                {t("landing.terminal.changed", { files: 14 })}
              </span>
            </code>
          </pre>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="lp-section" id="how">
        <SectionEyebrow index="03">{t("landing.how.eyebrow")}</SectionEyebrow>
        <ol className="lp-steps">
          <li className="lp-step lp-reveal">
            <span className="lp-step__num">01</span>
            <h3>{t("landing.how.oneTitle")}</h3>
            <p>{t("landing.how.oneBody")}</p>
          </li>
          <li className="lp-step lp-reveal">
            <span className="lp-step__num">02</span>
            <h3>{t("landing.how.twoTitle")}</h3>
            <p>{t("landing.how.twoBody")}</p>
          </li>
          <li className="lp-step lp-reveal">
            <span className="lp-step__num">03</span>
            <h3>{t("landing.how.threeTitle")}</h3>
            <p>{t("landing.how.threeBody")}</p>
          </li>
        </ol>
      </section>

      {/* ── Pricing stub ── */}
      <section className="lp-section" id="pricing">
        <SectionEyebrow index="04">
          {t("landing.pricing.eyebrow")}
        </SectionEyebrow>
        <div className="lp-pricing">
          <div className="lp-price-card lp-reveal">
            <h2>{t("landing.pricing.title")}</h2>
            <p className="lp-price-card__amount">
              €0 <span>{t("landing.pricing.forever")}</span>
            </p>
            <p>{t("landing.pricing.body")}</p>
            <a
              className="lp-btn lp-btn--ghost"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("landing.pricing.clone")}
            </a>
          </div>
        </div>
      </section>

      {/* ── Get started / sign-in anchor ── */}
      <section className="lp-section lp-section--cta" id="get-started">
        <h2 className="lp-cta-title">
          {t("landing.cta.readyPrefix")}{" "}
          <em className="lp-h1__accent">{t("landing.cta.readyAccent")}</em>.
        </h2>
        <pre className="lp-install">
          <code>
            <span className="lp-t-prompt">$ </span>bun install -g opencodex &&
            ocx
          </code>
        </pre>
        <div className="lp-cta-row">
          <a
            className="lp-btn lp-btn--primary"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
          >
            {t("landing.cta.docs")}
          </a>
          <a className="lp-btn lp-btn--ghost" id="signin" href="/#dashboard">
            {t("landing.cta.dashboard")}
          </a>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="lp-footer">
        <div className="lp-footer__brand">
          <Mark size={18} />
          <span>OpenCodex</span>
        </div>
        <nav className="lp-footer__links" aria-label={t("landing.footer.aria")}>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            {t("landing.nav.docs")}
          </a>
          <a
            href={`${GITHUB_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer"
          >
            {t("landing.footer.license")}
          </a>
        </nav>
        <p className="lp-footer__note">{t("landing.footer.note")}</p>
      </footer>
    </div>
  );
}
