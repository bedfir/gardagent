import { ref } from "vue";
import { fr, type MessageKey, type Messages } from "./i18n/fr";
import { en } from "./i18n/en";

export type Locale = "fr" | "en";
export type { MessageKey };

const DICTIONARIES: Record<Locale, Messages> = { fr, en };
export const LOCALES: readonly Locale[] = ["fr", "en"];
export const LOCALE_STORAGE_KEY = "gardagent.console.locale";

const isLocale = (value: unknown): value is Locale => value === "fr" || value === "en";

/**
 * Initial locale: the saved choice wins; otherwise the browser language
 * ("fr*" gives French, anything else English); with no browser language, French
 * (the existing users are French). Every storage access is guarded: storage may throw.
 */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage unavailable or blocked: fall through to the browser language
  }
  const language = typeof navigator === "undefined" ? "" : navigator.language;
  if (!language) return "fr";
  return language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const locale = ref<Locale>(detectLocale());

function applyToDocument(value: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = value;
  document.title = DICTIONARIES[value]["app.title"];
}

/** Changes the active locale, remembers it (best effort) and updates the page language. */
export function setLocale(value: Locale): void {
  locale.value = value;
  applyToDocument(value);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, value);
  } catch {
    // storage unavailable: the choice just does not survive a reload
  }
}

applyToDocument(locale.value);

/** True when `key` is a dictionary key (for keys built at runtime, such as `reason.${code}`). */
export function hasKey(key: string): key is MessageKey {
  return Object.hasOwn(fr, key);
}

/** Translation with {name} interpolation. Reads `locale`, so templates re-render on a change. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = DICTIONARIES[locale.value][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** BCP 47 tag for number, date and time formatting. */
export function numberLocale(): string {
  return locale.value === "fr" ? "fr-FR" : "en-US";
}

/**
 * "n unit" with the plural rule of the active language: French uses the singular for 0 and 1,
 * English only for exactly 1. `one` and `many` are already-translated nouns.
 */
export function plural(n: number, one: string, many: string): string {
  const singular = locale.value === "fr" ? n <= 1 : n === 1;
  return `${n} ${singular ? one : many}`;
}
