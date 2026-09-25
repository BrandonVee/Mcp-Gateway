import { GlobalOutlined } from "@ant-design/icons";
import { Select } from "antd";
import { useI18n, type Language } from "../i18n";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <span className={`language-switcher${compact ? " compact" : ""}`}>
      <GlobalOutlined aria-hidden="true" />
      <Select<Language>
        aria-label={t("locale.selectLanguage")}
        value={language}
        onChange={setLanguage}
        popupMatchSelectWidth={false}
        options={[{ value: "zh-CN", label: "中文" }, { value: "en-US", label: "English" }]}
      />
    </span>
  );
}
