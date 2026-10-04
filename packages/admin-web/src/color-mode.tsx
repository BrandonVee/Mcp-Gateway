import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ColorMode = 'light' | 'dark';
export type ThemePreference = ColorMode | 'system';
const STORAGE_KEY = 'mcp-console-theme';

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* Storage may be unavailable. */
  }
  return 'system';
}
function systemMode(): ColorMode {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const ThemeContext = createContext<{
  mode: ColorMode;
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<ColorMode>(systemMode);
  const mode = preference === 'system' ? system : preference;
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const changed = () => setSystem(query.matches ? 'dark' : 'light');
    changed();
    // Older Safari uses addListener rather than addEventListener.
    if (query.addEventListener) query.addEventListener('change', changed);
    else query.addListener(changed);
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', changed);
      else query.removeListener(changed);
    };
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setPreference(readPreference());
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', mode === 'dark' ? '#070b13' : '#f3f6fb');
  }, [mode]);
  const value = useMemo(
    () => ({
      mode,
      preference,
      setPreference: (next: ThemePreference) => {
        setPreference(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* Keep the in-memory preference. */
        }
      },
    }),
    [mode, preference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useColorMode() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is missing');
  return value;
}
