import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

export type Theme = "dark" | "light";
const KEY = "recoup.theme";

function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => unknown };

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggle = useCallback(
    (origin?: { x: number; y: number }) => {
      const next: Theme = theme === "dark" ? "light" : "dark";
      const doc = document as ViewTransitionDoc;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (origin) {
        document.documentElement.style.setProperty("--vt-x", `${origin.x}px`);
        document.documentElement.style.setProperty("--vt-y", `${origin.y}px`);
      }
      const apply = () => {
        document.documentElement.classList.toggle("dark", next === "dark");
        setTheme(next);
      };
      if (doc.startViewTransition && !reduce) {
        doc.startViewTransition(() => flushSync(apply));
      } else {
        apply();
      }
    },
    [theme]
  );

  return { theme, toggle };
}
