import { lazy, Suspense, useEffect, useState } from "react";

/**
 * HeroCanvas — lazy ThreeUI ParticleNetwork as the landing hero background.
 *
 * Gates (all must pass before the WebGL iframe is even imported):
 *  - viewport >= 768px (mobile gets the static poster)
 *  - no prefers-reduced-motion
 *  - WebGL available
 *  - tab visible (render pauses when hidden via the effect's own rAF, but we
 *    also avoid mounting while hidden)
 *
 * The ThreeUI effect renders inside a sandboxed iframe with pointer-events
 * off, capped DPR, and a slow drift. Colors are driven into the cyan palette
 * via the effect's hue/saturation controls plus a CSS tint fallback.
 */

const ParticleNetwork = lazy(async () => {
  const mod = await import("@designcodeio/threeui/components/ParticleNetwork");
  return { default: mod.ParticleNetwork };
});

function useWebGLSupport(): boolean {
  const [supported] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const canvas = document.createElement("canvas");
      return !!(
        canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl")
      );
    } catch {
      return false;
    }
  });
  return supported;
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export default function HeroCanvas() {
  const webgl = useWebGLSupport();
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const isPhone = useMedia("(max-width: 767px)");
  const [visible, setVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const enabled = webgl && !reducedMotion && !isPhone && visible;

  return (
    <div className="hero-canvas" aria-hidden="true">
      {/* Static poster fallback — always present under the live scene so the
          first paint and all fallback modes share the same dark field. */}
      <div className="hero-canvas__poster" />
      {enabled && (
        <Suspense fallback={null}>
          <div className="hero-canvas__scene">
            <ParticleNetwork
              mode="dark"
              speed={0.35}
              density={1.1}
              opacity={0.85}
              hue={150}
              saturation={1.2}
              brightness={0.9}
              style={{ pointerEvents: "none" }}
            />
          </div>
        </Suspense>
      )}
      {/* Readability gradient: keeps white type sharp over the scene. */}
      <div className="hero-canvas__scrim" />
    </div>
  );
}
