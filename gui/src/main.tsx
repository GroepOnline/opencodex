import React from "react";
import ReactDOM from "react-dom/client";
// ChefGroep design language: Archivo (UI, the free General Sans equivalent) +
// JetBrains Mono (data only). Bundled locally so nothing depends on a CDN.
import "@fontsource-variable/archivo/wght.css";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { LanguageProvider } from "./i18n/provider";
import "./styles.css";

// ChefGroep design language ships two complete skins (design-system §14).
// devin (warm, default) is the :root skin; strak (cool, sharp) is opt-in via
// ?style=strak or a saved choice. Applied before first paint to avoid a flash.
try {
  const params = new URLSearchParams(window.location.search);
  const style = params.get("style") ?? localStorage.getItem("ocx-style");
  if (style === "strak" || style === "devin") {
    document.documentElement.setAttribute("data-style", style);
    localStorage.setItem("ocx-style", style);
  }
} catch { /* ignore */ }

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>
);
