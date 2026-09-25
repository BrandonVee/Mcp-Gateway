import { getTranslation, type Language } from "../i18n";

export function formatTime(timestamp?: number, language: Language = "zh-CN") {
  if (!timestamp) return getTranslation("errors.waitingSync", language);

  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

export function initials(value: string) {
  return value.slice(0, 2).toUpperCase();
}
