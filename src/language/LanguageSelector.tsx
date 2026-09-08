import { Select } from "antd";
import { enUS } from "../translations/en-US.js";
import { zhCNLanguageName } from "../translations/zh-CN.js";
import { useLanguage } from "./react.js";
import type { SupportedLanguage } from "./types.js";

export const LANGUAGE_OPTIONS = [
  { value: "zh-CN", label: zhCNLanguageName },
  { value: "en-US", label: enUS["common.language.english"] },
] satisfies Array<{ value: SupportedLanguage; label: string }>;

export interface LanguageSelectorProps {
  disabled?: boolean;
  onChange: (language: SupportedLanguage) => void;
}

export function LanguageSelector({ disabled, onChange }: LanguageSelectorProps) {
  const { language } = useLanguage();

  return (
    <Select<SupportedLanguage>
      value={language}
      disabled={disabled}
      options={LANGUAGE_OPTIONS}
      onChange={onChange}
    />
  );
}
