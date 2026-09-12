import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";

// Theme toggle (2026-08-12). Dark is the default — the inline bootstrap in
// index.html adds the `dark` class to <html> before first paint (no flash),
// reading the saved choice from localStorage. This button flips it and persists
// the choice. All theming flows from that `dark` class via the tokens in
// index.css, so nothing else needs to know about the current mode.
const STORAGE_KEY = "cannaqms-theme";

function currentIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(currentIsDark);

  // Sync to whatever the bootstrap applied on load.
  useEffect(() => { setIsDark(currentIsDark()); }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem(STORAGE_KEY, next ? "dark" : "light"); } catch { /* ignore */ }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      data-testid="button-theme-toggle"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
