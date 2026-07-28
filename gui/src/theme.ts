export type Theme = "light" | "dark" | "system";

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem("ocx-theme");
    if (t === "light" || t === "dark") return t;
  } catch { /* ignore */ }
  return "system";
}

export function applyTheme(next: Theme) {
  try {
    if (next === "system") {
      localStorage.removeItem("ocx-theme");
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem("ocx-theme", next);
      document.documentElement.setAttribute("data-theme", next);
    }
  } catch { /* ignore */ }
}
