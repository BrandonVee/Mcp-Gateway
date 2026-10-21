import type { ReactNode } from 'react';
import {
  SettingOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  LogoutOutlined,
  LinkOutlined,
  KeyOutlined,
  MonitorOutlined,
  AuditOutlined,
  ShareAltOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  DownOutlined,
  ReloadOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Layout, Menu, Space, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { View } from '@/web/types';
import { CommandPalette } from '@/web/components/CommandPalette';
import { BrandMark } from '@/web/components/BrandMark';
import { LanguageSwitcher } from '@/web/components/LanguageSwitcher';
import { ThemeSwitcher } from '@/web/components/ThemeSwitcher';
import { useColorMode } from '@/web/color-mode';
import { useI18n, type MessageKey } from '@/web/i18n';
import '@/web/components/app-shell.css';

const { Header, Sider, Content } = Layout;

const titles: Record<View, MessageKey> = {
  settings: 'settings.title',
  overview: 'nav.overview.label',
  users: 'nav.users.label',
  servers: 'nav.servers.label',
  credentials: 'nav.connections.title',
  monitoring: 'nav.monitoring.title',
  audit: 'nav.audit.title',
  topology: 'nav.topology.label',
};

interface AppShellProps {
  children: ReactNode;
  currentView: View;
  refreshing: boolean;
  loggingOut: boolean;
  onNavigate: (view: View) => void;
  onRefresh: () => void;
  onLogout: () => void;
}

export function AppShell({
  children,
  currentView,
  refreshing,
  loggingOut,
  onNavigate,
  onRefresh,
  onLogout,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t } = useI18n();
  const { mode } = useColorMode();
  const current = titles[currentView];

  useEffect(() => {
    const viewport = window.matchMedia('(max-width: 820px)');
    const closeMenuOnDesktop = () => {
      if (!viewport.matches) setMobileMenuOpen(false);
    };
    viewport.addEventListener('change', closeMenuOnDesktop);
    return () => viewport.removeEventListener('change', closeMenuOnDesktop);
  }, []);

  const menuItems = [
    { key: 'overview', icon: <DashboardOutlined />, label: t('nav.overview.label') },
    {
      key: 'users',
      icon: <TeamOutlined />,
      label: t('nav.users.label'),
    },
    {
      key: 'servers',
      icon: <CloudServerOutlined />,
      label: t('nav.servers.label'),
    },
    { key: 'credentials', icon: <KeyOutlined />, label: t('nav.connections.title') },
    { key: 'topology', icon: <ShareAltOutlined />, label: t('nav.topology.label') },
    { key: 'monitoring', icon: <MonitorOutlined />, label: t('nav.monitoring.title') },
    { key: 'audit', icon: <AuditOutlined />, label: t('nav.audit.title') },
    { key: 'settings', icon: <SettingOutlined />, label: t('settings.title') },
  ];

  return (
    <Layout className="app-layout">
      <Sider
        className="app-sider"
        width={208}
        collapsedWidth={64}
        collapsed={collapsed}
        trigger={null}
        theme={mode}
        breakpoint="lg"
        onBreakpoint={(broken) => setCollapsed(broken)}
      >
        <div className={collapsed ? 'brand compact' : 'brand'}>
          <BrandMark className="brand-symbol" />
          {!collapsed && (
            <span className="brand-copy">
              <strong>{t('app.documentTitle')}</strong>
              <small>{t('app.controlPlane')}</small>
            </span>
          )}
        </div>

        {!collapsed && <div className="sider-section-label">{t('nav.workspace')}</div>}
        <Menu
          theme={mode}
          mode="inline"
          selectedKeys={[currentView]}
          items={menuItems}
          onClick={({ key }) => onNavigate(key as View)}
        />

        <div className="sider-footer">
          <Button
            type="text"
            block
            href="/connections"
            icon={<LinkOutlined />}
            className="connections-nav-button"
            aria-label={t('nav.personalConnections')}
            title={collapsed ? t('nav.personalConnections') : undefined}
          >
            {!collapsed && t('nav.personalConnections')}
          </Button>
          <Button
            type="text"
            block
            icon={<LogoutOutlined />}
            className="logout-button"
            loading={loggingOut}
            disabled={refreshing}
            onClick={onLogout}
            aria-label={t('nav.signOut')}
            title={collapsed ? t('nav.signOut') : undefined}
          >
            {!collapsed && t('nav.signOut')}
          </Button>
          <Tooltip title={collapsed ? t('nav.expandSidebar') : undefined} placement="right">
            <Button
              type="text"
              block
              className="sidebar-toggle"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
              aria-expanded={!collapsed}
            >
              {!collapsed && t('nav.collapseSidebar')}
            </Button>
          </Tooltip>
        </div>
      </Sider>

      <Layout className="site-layout">
        <Header className="app-header">
          <div className="page-heading desktop-page-heading">
            <Typography.Title level={2}>{t(current)}</Typography.Title>
          </div>

          <Dropdown
            open={mobileMenuOpen}
            onOpenChange={setMobileMenuOpen}
            trigger={['click']}
            placement="bottomLeft"
            overlayClassName="mobile-navigation-menu"
            menu={{
              selectedKeys: [currentView],
              items: [
                ...menuItems,
                { type: 'divider' },
                {
                  key: 'personal-connections',
                  icon: <LinkOutlined />,
                  label: <a href="/connections">{t('nav.personalConnections')}</a>,
                },
                {
                  key: 'refresh',
                  icon: <ReloadOutlined spin={refreshing} />,
                  label: t('common.refresh'),
                  disabled: refreshing,
                },
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: t('nav.signOut'),
                  danger: true,
                  disabled: loggingOut || refreshing,
                },
              ],
              onClick: ({ key }) => {
                setMobileMenuOpen(false);
                if (key === 'logout') onLogout();
                else if (key === 'refresh') onRefresh();
                else if (key in titles) onNavigate(key as View);
              },
            }}
          >
            <Button
              type="text"
              className="mobile-navigation-trigger"
              icon={<MenuOutlined />}
              aria-label={t('nav.navigationMenu')}
              aria-expanded={mobileMenuOpen}
              aria-haspopup="menu"
            >
              <span className="mobile-navigation-title">{t(current)}</span>
              <DownOutlined className="mobile-navigation-chevron" />
            </Button>
          </Dropdown>

          <Space size={10} className="header-actions">
            <div className="header-preferences">
              <ThemeSwitcher />
              <LanguageSwitcher />
            </div>
            <Space size={10} className="header-operations">
              <CommandPalette onNavigate={onNavigate} />
              <Button icon={<ReloadOutlined spin={refreshing} />} loading={refreshing} onClick={onRefresh}>
                {t('common.refresh')}
              </Button>
            </Space>
          </Space>
        </Header>

        <Content className="app-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
