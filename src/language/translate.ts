import { enUS } from "../translations/en-US.js";
import { zhCN } from "../translations/zh-CN.js";
import type {
  SupportedLanguage,
  TranslationCatalog,
  TranslationKey,
  TranslationParams,
} from "./types.js";

export const DEFAULT_LANGUAGE: SupportedLanguage = "zh-CN";
export const SUPPORTED_LANGUAGES = ["zh-CN", "en-US"] as const satisfies readonly SupportedLanguage[];

const translations: Record<SupportedLanguage, TranslationCatalog> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === "zh-CN" || value === "en-US";
}

export function translate(
  language: SupportedLanguage,
  key: TranslationKey,
  params?: TranslationParams,
): string {
  const catalog = translations[language];
  if (!Object.prototype.hasOwnProperty.call(catalog, key)) {
    throw new Error(`Unknown translation key: ${String(key)}`);
  }

  const value = catalog[key];
  return value.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
    if (!params || !(name in params)) {
      throw new Error(`Missing translation parameter: ${name}`);
    }
    return String(params[name]);
  });
}
