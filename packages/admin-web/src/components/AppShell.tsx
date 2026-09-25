import type { ReactNode } from "react";
import {
  AppstoreOutlined,
  ClockCircleOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  LogoutOutlined,
  LinkOutlined,
  KeyOutlined,
  MonitorOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Badge,
  Button,
  Flex,
  Layout,
  Menu,
  Space,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import type { View } from "../types";
import { formatTime } from "../utils/format";
import { CommandPalette } from "./CommandPalette";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useI18n, type MessageKey } from "../i18n";

const { Header, Sider, Content } = Layout;

const titles: Record<
  View,
  { eyebrow: MessageKey; title: MessageKey; description: MessageKey }
> = {
  overview: {
    eyebrow: "nav.overview.eyebrow",
    title: "nav.overview.title",
    description: "nav.overview.description",
  },
  users: {
    eyebrow: "nav.users.eyebrow",
    title: "nav.users.title",
    description: "nav.users.description",
  },
  servers: {
    eyebrow: "nav.servers.eyebrow",
    title: "nav.servers.title",
    description: "nav.servers.description",
  },
  credentials: {
    eyebrow: "nav.connections.eyebrow",
    title: "nav.connections.title",
    description: "nav.connections.description",
  },
  monitoring: {
    eyebrow: "nav.monitoring.eyebrow",
    title: "nav.monitoring.title",
    description: "nav.monitoring.description",
  },
};

interface AppShellProps {
  children: ReactNode;
  currentView: View;
  userCount: number;
  serverCount: number;
  refreshing: boolean;
  lastUpdatedAt: number | null;
  onNavigate: (view: View) => void;
  onRefresh: () => void;
  onLogout: () => void;
}

export function AppShell({
  children,
  currentView,
  userCount,
  serverCount,
  refreshing,
  lastUpdatedAt,
  onNavigate,
  onRefresh,
  onLogout,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { t, language } = useI18n();
  const current = titles[currentView];

  const menuItems = [
    { key: "overview", icon: <DashboardOutlined />, label: t("nav.overview.label") },
    {
      key: "users",
      icon: <TeamOutlined />,
      label: t("nav.users.label"),
      extra: <span className="menu-count">{userCount}</span>,
    },
    {
      key: "servers",
      icon: <CloudServerOutlined />,
      label: t("nav.servers.label"),
      extra: <span className="menu-count">{serverCount}</span>,
    },
    { key: "credentials", icon: <KeyOutlined />, label: t("nav.connections.title") },
    { key: "monitoring", icon: <MonitorOutlined />, label: t("nav.monitoring.title") },
  ];

  return (
    <Layout className="app-layout">
      <Sider
        className="app-sider"
        width={248}
        collapsedWidth={80}
        collapsed={collapsed}
        trigger={null}
        theme="dark"
        breakpoint="lg"
        onBreakpoint={(broken) => setCollapsed(broken)}
      >
        <div className={collapsed ? "brand compact" : "brand"}>
          <span className="brand-symbol">
            <AppstoreOutlined />
          </span>
          {!collapsed && (
            <span className="brand-copy">
              <strong>{t("app.documentTitle")}</strong>
              <small>{t("app.controlPlane")}</small>
            </span>
          )}
        </div>

        {!collapsed && <div className="sider-section-label">{t("nav.workspace")}</div>}
        <Menu
          theme="dark"
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
          >
            {!collapsed && t("nav.personalConnections")}
          </Button>
          {!collapsed && (
            <div className="system-state">
              <Badge status="success" />
              <span>
                <strong>{t("nav.servicesOnline")}</strong>
                <small>{t("app.controlPlaneOnline")}</small>
              </span>
            </div>
          )}
          <Button
            type="text"
            block
            icon={<LogoutOutlined />}
            className="logout-button"
            onClick={onLogout}
          >
            {!collapsed && t("nav.signOut")}
          </Button>
        </div>
      </Sider>

      <Layout className="site-layout">
        <Header className="app-header">
          <Flex align="center" gap={14}>
            <Button
              type="text"
              className="collapse-button"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
            />
            <div className="page-heading">
              <Typography.Text className="page-eyebrow">
                {t(current.eyebrow)}
              </Typography.Text>
              <Flex align="baseline" gap={12} wrap>
                <Typography.Title level={2}>{t(current.title)}</Typography.Title>
                <Typography.Text type="secondary">
                  {t(current.description)}
                </Typography.Text>
              </Flex>
            </div>
          </Flex>

          <Space size={10}>
            <LanguageSwitcher />
            <CommandPalette onNavigate={onNavigate} />
            {lastUpdatedAt && (
              <Tag icon={<ClockCircleOutlined />} className="updated-tag">
                {formatTime(lastUpdatedAt, language)}
              </Tag>
            )}
            <Tag
              icon={<SafetyCertificateOutlined />}
              color="success"
              className="secure-tag"
            >
              {t("app.secure")}
            </Tag>
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              loading={refreshing}
              onClick={onRefresh}
            >
              {t("common.refresh")}
            </Button>
          </Space>
        </Header>

        <Content className="app-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
