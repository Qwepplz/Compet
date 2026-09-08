import type { enUS } from "../translations/en-US.js";

export type SupportedLanguage = "zh-CN" | "en-US";
export type TranslationKey = keyof typeof enUS;
export type TranslationParams = Readonly<Record<string, string | number>>;
export type Translator = (key: TranslationKey, params?: TranslationParams) => string;

export type TranslationCatalog = { readonly [K in TranslationKey]: string };
