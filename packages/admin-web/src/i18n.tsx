import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { messages as zhMessages } from './locales/zh-CN';
import { messages as enMessages } from './locales/en-US';

export type Language = 'zh-CN' | 'en-US';

export type MessageKey = keyof typeof zhMessages;
const english: Record<MessageKey, string> = enMessages;

function interpolate(template: string, values?: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`));
}

const STORAGE_KEY = 'mcp-console-language';

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en-US') return saved;
  } catch {
    /* Storage may be disabled. */
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function getCurrentLanguage(): Language {
  return initialLanguage();
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = getTranslation('app.documentTitle', language);
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      /* Storage may be disabled. */
    }
  }, [language]);
  const t = useCallback(
    (key: MessageKey, values?: Record<string, string | number>) =>
      interpolate(language === 'en-US' ? english[key] : zhMessages[key], values),
    [language],
  );
  const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('I18nProvider is missing');
  return context;
}

export function getTranslation(key: MessageKey, language: Language, values?: Record<string, string | number>): string {
  return interpolate(language === 'en-US' ? english[key] : zhMessages[key], values);
}
