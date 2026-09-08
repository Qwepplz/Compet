import { ConfigProvider, type ThemeConfig } from "antd";
import antdEnUS from "antd/es/locale/en_US.js";
import antdZhCN from "antd/es/locale/zh_CN.js";
import type { Locale } from "antd/es/locale/index.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_LANGUAGE, translate } from "./translate.js";
import type {
  SupportedLanguage,
  TranslationKey,
  TranslationParams,
} from "./types.js";

export interface LanguageContextValue {
  language: SupportedLanguage;
  setLanguage(language: SupportedLanguage): Promise<void>;
  t(key: TranslationKey, params?: TranslationParams): string;
  formatDateTime(value: string | number | Date): string;
}

export interface LanguageProviderProps {
  initialLanguage: SupportedLanguage;
  saveLanguage: (language: SupportedLanguage) => Promise<void>;
  theme?: ThemeConfig;
  documentTitleKey?: TranslationKey;
  children: ReactNode;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export function LanguageProvider({
  initialLanguage,
  saveLanguage,
  theme,
  documentTitleKey,
  children,
}: LanguageProviderProps): ReactNode {
  const [language, setLanguageState] = useState<SupportedLanguage>(initialLanguage ?? DEFAULT_LANGUAGE);

  const setLanguage = useCallback(async (nextLanguage: SupportedLanguage): Promise<void> => {
    if (nextLanguage === language) return;
    await saveLanguage(nextLanguage);
    setLanguageState(nextLanguage);
  }, [language, saveLanguage]);

  const t = useCallback((key: TranslationKey, params?: TranslationParams): string => {
    return translate(language, key, params);
  }, [language]);

  const formatDateTime = useCallback((value: string | number | Date): string => {
    return new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value instanceof Date ? value : new Date(value));
  }, [language]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = language;
      if (documentTitleKey) {
        document.title = translate(language, documentTitleKey);
      }
    }
  }, [documentTitleKey, language]);

  const contextValue = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t,
    formatDateTime,
  }), [formatDateTime, language, setLanguage, t]);
  const locale = (language === "zh-CN" ? antdZhCN : antdEnUS) as unknown as Locale;

  return (
    <LanguageContext.Provider value={contextValue}>
      <ConfigProvider locale={locale} theme={theme}>{children}</ConfigProvider>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used inside LanguageProvider");
  return context;
}
