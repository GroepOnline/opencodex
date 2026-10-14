import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
const THEME_KEY = "ocx-theme";

function readStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    // Private/blocked storage must not prevent the dashboard from rendering.
    return "system";
  }
}

export function useAppTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme persistence is optional; blocked storage must not break rendering.
    }
  }, [theme]);
  return { theme, setTheme };
}
