import { DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';
import { useColorMode, type ThemePreference } from '../color-mode';
import { useI18n } from '../i18n';

export function ThemeSwitcher() {
  const { mode, preference, setPreference } = useColorMode();
  const { t } = useI18n();
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        selectedKeys: [preference],
        items: [
          { key: 'light', icon: <SunOutlined />, label: t('theme.light') },
          { key: 'dark', icon: <MoonOutlined />, label: t('theme.dark') },
          { key: 'system', icon: <DesktopOutlined />, label: t('theme.system') },
        ],
        onClick: ({ key }) => setPreference(key as ThemePreference),
      }}
    >
      <Button
        className="preference-trigger theme-trigger"
        icon={mode === 'light' ? <SunOutlined /> : <MoonOutlined />}
        aria-label={t('theme.select')}
        title={t('theme.select')}
      />
    </Dropdown>
  );
}
