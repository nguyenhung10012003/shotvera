import { create } from "zustand";
import { en, type MessageKey, type Messages, type Plural } from "./en";
import { vi } from "./vi";

export type { MessageKey } from "./en";

export type Locale = "en" | "vi";

export const DEFAULT_LOCALE: Locale = "en";

/** Languages offered in Settings. Each label is written in its own language. */
export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "vi", label: "Tiếng Việt" },
];

const CATALOGS: Record<Locale, Messages> = { en, vi };

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.id === value);
}

/** The active UI language. Components subscribe to it through `useT()`. */
export const useI18n = create<{ locale: Locale }>(() => ({ locale: DEFAULT_LOCALE }));

export function setLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  if (useI18n.getState().locale !== locale) useI18n.setState({ locale });
}

export function getLocale(): Locale {
  return useI18n.getState().locale;
}

export type Params = Record<string, string | number>;

/**
 * Translates `key` into the active language. A `{name}` placeholder is replaced by the parameter
 * of the same name. Plural entries choose their form from `params.count`.
 */
export function t(key: MessageKey, params?: Params): string {
  const locale = getLocale();
  const entry: string | Plural = CATALOGS[locale][key] ?? en[key];
  const text =
    typeof entry === "string"
      ? entry
      : new Intl.PluralRules(locale).select(Number(params?.count ?? 0)) === "one"
        ? entry.one
        : entry.other;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Returns `t`, and re-renders the calling component when the language changes. */
export function useT(): typeof t {
  useI18n((s) => s.locale);
  return t;
}
