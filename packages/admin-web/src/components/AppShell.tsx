import type { ReactNode } from "react";
import {
  AppstoreOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  LogoutOutlined,
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

const { Header, Sider, Content } = Layout;

const titles: Record<
  View,
  { eyebrow: string; title: string; description: string }
> = {
  overview: {
    eyebrow: "CONTROL PLANE / OVERVIEW",
    title: "运行态势",
    description: "统一观察身份、路由与基础设施状态",
  },
  users: {
    eyebrow: "CONTROL PLANE / ACCESS",
    title: "身份与访问",
    description: "管理用户及其 MCP Server 授权边界",
  },
  servers: {
    eyebrow: "CONTROL PLANE / REGISTRY",
    title: "Server 注册表",
    description: "编排逻辑路由、上游实例与服务状态",
  },
};

interface AppShellProps {
  children: ReactNode;
  currentView: View;
  userCount: number;
  serverCount: number;
  refreshing: boolean;
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
  onNavigate,
  onRefresh,
  onLogout,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const current = titles[currentView];

  const menuItems = [
    { key: "overview", icon: <DashboardOutlined />, label: "运行总览" },
    {
      key: "users",
      icon: <TeamOutlined />,
      label: "用户与授权",
      extra: <span className="menu-count">{userCount}</span>,
    },
    {
      key: "servers",
      icon: <CloudServerOutlined />,
      label: "Server 注册",
      extra: <span className="menu-count">{serverCount}</span>,
    },
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
              <strong>MCP Console</strong>
              <small>CONTROL PLANE</small>
            </span>
          )}
        </div>

        {!collapsed && <div className="sider-section-label">工作台</div>}
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[currentView]}
          items={menuItems}
          onClick={({ key }) => onNavigate(key as View)}
        />

        <div className="sider-footer">
          {!collapsed && (
            <div className="system-state">
              <Badge status="success" />
              <span>
                <strong>服务运行中</strong>
                <small>CONTROL PLANE ONLINE</small>
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
            {!collapsed && "退出管理台"}
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
              aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            />
            <div className="page-heading">
              <Typography.Text className="page-eyebrow">
                {current.eyebrow}
              </Typography.Text>
              <Flex align="baseline" gap={12} wrap>
                <Typography.Title level={2}>{current.title}</Typography.Title>
                <Typography.Text type="secondary">
                  {current.description}
                </Typography.Text>
              </Flex>
            </div>
          </Flex>

          <Space size={12}>
            <Tag
              icon={<SafetyCertificateOutlined />}
              color="success"
              className="secure-tag"
            >
              SECURE
            </Tag>
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              loading={refreshing}
              onClick={onRefresh}
            >
              刷新
            </Button>
          </Space>
        </Header>

        <Content className="app-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
