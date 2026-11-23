// cyphos-guard light/dark switch. Loaded in <head> so the saved choice applies before the first paint.
// Without a saved choice the page follows the device setting. Any element with [data-theme-toggle] switches.
(() => {
  const KEY = "cg-theme";
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch {}
  const current = () => {
    const t = root.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-theme-toggle]") : null;
    if (!el) return;
    const next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {}
  });
})();
