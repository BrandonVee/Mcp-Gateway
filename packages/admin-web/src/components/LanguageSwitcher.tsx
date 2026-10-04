import { DownOutlined, GlobalOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';
import { useI18n, type Language } from '../i18n';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <span className={`language-switcher${compact ? ' compact' : ''}`}>
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        overlayClassName="language-menu"
        menu={{
          selectedKeys: [language],
          items: [
            { key: 'zh-CN', label: '中文' },
            { key: 'en-US', label: 'English' },
          ],
          onClick: ({ key }) => setLanguage(key as Language),
        }}
      >
        <Button className="preference-trigger language-trigger" aria-label={t('locale.selectLanguage')}>
          <GlobalOutlined aria-hidden="true" />
          <span>{language === 'zh-CN' ? '中文' : 'English'}</span>
          <DownOutlined className="language-chevron" aria-hidden="true" />
        </Button>
      </Dropdown>
    </span>
  );
}
