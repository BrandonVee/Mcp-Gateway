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
import { useI18n, type MessageKey } from "../i18n";

const commands: Array<{
  view: View;
  title: MessageKey;
  description: MessageKey;
  keywords: string;
  icon: ReactNode;
  shortcut: string;
}> = [
  {
    view: "overview",
    title: "nav.overview.title",
    description: "nav.overview.description",
    keywords: "overview dashboard status 总览 运行",
    icon: <DashboardOutlined />,
    shortcut: "G O",
  },
  {
    view: "users",
    title: "nav.users.title",
    description: "nav.users.description",
    keywords: "users identity access 用户 身份 权限",
    icon: <TeamOutlined />,
    shortcut: "G U",
  },
  {
    view: "servers",
    title: "nav.servers.title",
    description: "nav.servers.description",
    keywords: "servers registry routes 服务 实例 路由",
    icon: <CloudServerOutlined />,
    shortcut: "G S",
  },
  {
    view: "credentials",
    title: "nav.connections.title",
    description: "nav.connections.description",
    keywords: "credentials connections api key oauth 二次认证 连接",
    icon: <KeyOutlined />,
    shortcut: "G C",
  },
  {
    view: "monitoring",
    title: "nav.monitoring.title",
    description: "nav.monitoring.description",
    keywords: "monitoring audit logs observability 日志 监控 审计",
    icon: <MonitorOutlined />,
    shortcut: "G M",
  },
];

interface CommandPaletteProps {
  onNavigate: (view: View) => void;
}

export function CommandPalette({ onNavigate }: CommandPaletteProps) {
  const { t } = useI18n();
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
      `${t(command.title)} ${t(command.description)} ${command.keywords}`
        .toLowerCase()
        .includes(query),
    );
  }, [keyword, t]);

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
        <span>{t("nav.quickSearch")}</span>
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
            placeholder={t("nav.searchPlaceholder")}
            onChange={(event) => setKeyword(event.target.value)}
            onPressEnter={() =>
              filteredCommands[0] && navigate(filteredCommands[0].view)
            }
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-caption">{t("nav.commandNavigation")}</div>
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
                  <strong>{t(command.title)}</strong>
                  <small>{t(command.description)}</small>
                </span>
                <Tag bordered={false}>{command.shortcut}</Tag>
                <RightOutlined className="command-arrow" />
              </button>
            ))
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("nav.noMatches")}
            />
          )}
        </div>
        <div className="command-footer">
          <span>
            <kbd>↵</kbd> {t("common.open")}
          </span>
          <span>
            <kbd>ESC</kbd> {t("common.close")}
          </span>
          <i /> {t("nav.commandFooter")}
        </div>
      </Modal>
    </>
  );
}
