import {
  CloudServerOutlined,
  DashboardOutlined,
  RightOutlined,
  SearchOutlined,
  TeamOutlined,
  KeyOutlined,
  MonitorOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Empty, Input, Modal, Tag } from "antd";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { View } from "../types";

const commands: Array<{
  view: View;
  title: string;
  description: string;
  keywords: string;
  icon: ReactNode;
  shortcut: string;
}> = [
  {
    view: "overview",
    title: "运行态势",
    description: "查看系统指标、实时路由拓扑和基础设施状态",
    keywords: "overview dashboard status 总览 运行",
    icon: <DashboardOutlined />,
    shortcut: "G O",
  },
  {
    view: "users",
    title: "身份与访问",
    description: "管理用户、角色和 MCP Server 授权边界",
    keywords: "users identity access 用户 身份 权限",
    icon: <TeamOutlined />,
    shortcut: "G U",
  },
  {
    view: "servers",
    title: "Server 注册表",
    description: "管理逻辑路由与上游服务实例",
    keywords: "servers registry routes 服务 实例 路由",
    icon: <CloudServerOutlined />,
    shortcut: "G S",
  },
  {
    view: "credentials",
    title: "二次认证",
    description: "查看用户的 API Key 与 OAuth 连接状态",
    keywords: "credentials connections api key oauth 二次认证 连接",
    icon: <KeyOutlined />,
    shortcut: "G C",
  },
  {
    view: "monitoring",
    title: "日志监控",
    description: "查看服务健康状态与管理操作审计",
    keywords: "monitoring audit logs observability 日志 监控 审计",
    icon: <MonitorOutlined />,
    shortcut: "G M",
  },
];

interface CommandPaletteProps {
  onNavigate: (view: View) => void;
}

export function CommandPalette({ onNavigate }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const filteredCommands = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    if (!query) return commands;
    return commands.filter((command) =>
      `${command.title} ${command.description} ${command.keywords}`
        .toLowerCase()
        .includes(query),
    );
  }, [keyword]);

  const close = () => {
    setOpen(false);
    setKeyword("");
  };

  const navigate = (view: View) => {
    onNavigate(view);
    close();
  };

  return (
    <>
      <button
        className="command-trigger"
        type="button"
        onClick={() => setOpen(true)}
      >
        <SearchOutlined />
        <span>快速导航</span>
        <kbd>⌘ K</kbd>
      </button>

      <Modal
        open={open}
        width={620}
        footer={null}
        closable={false}
        className="command-modal"
        onCancel={close}
        destroyOnHidden
      >
        <div className="command-search">
          <ThunderboltOutlined />
          <Input
            autoFocus
            variant="borderless"
            value={keyword}
            placeholder="搜索页面或输入命令…"
            onChange={(event) => setKeyword(event.target.value)}
            onPressEnter={() =>
              filteredCommands[0] && navigate(filteredCommands[0].view)
            }
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-caption">NAVIGATION / 导航</div>
        <div className="command-list">
          {filteredCommands.length ? (
            filteredCommands.map((command) => (
              <button
                key={command.view}
                type="button"
                onClick={() => navigate(command.view)}
              >
                <span className="command-icon">{command.icon}</span>
                <span className="command-copy">
                  <strong>{command.title}</strong>
                  <small>{command.description}</small>
                </span>
                <Tag bordered={false}>{command.shortcut}</Tag>
                <RightOutlined className="command-arrow" />
              </button>
            ))
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="未找到匹配命令"
            />
          )}
        </div>
        <div className="command-footer">
          <span>
            <kbd>↵</kbd> 打开
          </span>
          <span>
            <kbd>ESC</kbd> 关闭
          </span>
          <i /> MCP CONTROL PLANE
        </div>
      </Modal>
    </>
  );
}
