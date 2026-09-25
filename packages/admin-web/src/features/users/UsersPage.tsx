import { useI18n } from "../../i18n";
import {
  DeleteOutlined,
  KeyOutlined,
  LinkOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Avatar,
  Button,
  Card,
  Flex,
  Input,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMemo, useState } from "react";
import { PageToolbar } from "../../components/PageToolbar";
import type { AdminUser } from "../../types";
import { initials } from "../../utils/format";

interface UsersPageProps {
  users: AdminUser[];
  onCreate: () => void;
  onAssign: (user: AdminUser) => void;
  onPassword: (user: AdminUser) => void;
  onToggle: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
}

export function UsersPage({
  users,
  onCreate,
  onAssign,
  onPassword,
  onToggle,
  onDelete,
}: UsersPageProps) {
  const { t } = useI18n();
  const [keyword, setKeyword] = useState("");
  const [role, setRole] = useState<"all" | AdminUser["role"]>("all");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");

  const filteredUsers = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return users.filter((user) => {
      const matchesKeyword =
        !normalizedKeyword ||
        user.username.toLowerCase().includes(normalizedKeyword) ||
        user.servers.some((server) =>
          server.toLowerCase().includes(normalizedKeyword),
        );
      const matchesRole = role === "all" || user.role === role;
      const matchesStatus =
        status === "all" ||
        (status === "active" && !user.disabled) ||
        (status === "disabled" && user.disabled);
      return matchesKeyword && matchesRole && matchesStatus;
    });
  }, [keyword, role, status, users]);

  const columns: ColumnsType<AdminUser> = [
    {
      title: t("common.user"),
      dataIndex: "username",
      key: "username",
      render: (_, user) => (
        <Flex align="center" gap={12}>
          <Avatar
            className={
              user.role === "admin" ? "user-avatar admin" : "user-avatar"
            }
          >
            {initials(user.username)}
          </Avatar>
          <span className="identity-copy">
            <strong>{user.username}</strong>
            <small>{t("common.identifier")} / {String(user.id).padStart(4, "0")}</small>
          </span>
        </Flex>
      ),
    },
    {
      title: t("common.role"),
      dataIndex: "role",
      key: "role",
      width: 120,
      render: (role: AdminUser["role"]) => (
        <Tag
          icon={
            role === "admin" ? <SafetyCertificateOutlined /> : <UserOutlined />
          }
          color={role === "admin" ? "blue" : "default"}
        >
          {role === "admin" ? t("common.administrator") : t("common.standardUser")}
        </Tag>
      ),
    },
    {
      title: t("users.serverAccess"),
      dataIndex: "servers",
      key: "servers",
      render: (servers: string[], user) => (
        <Flex gap={6} wrap>
          {servers.length ? (
            servers.map((name) => (
              <Tag
                key={name}
                bordered={false}
                color={name === "*" ? "success" : "processing"}
                className="scope-tag"
              >
                {name === "*" ? user.role === "admin" ? t("users.adminServers") : t("users.servers") : name}
              </Tag>
            ))
          ) : (
            <Typography.Text type="secondary">{t("users.noGrants")}</Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      title: t("users.userSign"),
      dataIndex: "disabled",
      key: "disabled",
      width: 150,
      render: (disabled: boolean, user) => (
        <Switch
          checked={!disabled}
          checkedChildren={t("users.signEnabled")}
          unCheckedChildren={t("users.signDisabled")}
          disabled={user.username === "admin"}
          onChange={() => onToggle(user)}
        />
      ),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 156,
      align: "right",
      render: (_, user) => (
        <Space size={4}>
          {user.role === "user" && <Tooltip title={t("servers.assignAccess")}>
            <Button
              type="text"
              icon={<LinkOutlined />}
              onClick={() => onAssign(user)}
            />
          </Tooltip>}
          <Tooltip title={t("users.resetPassword")}>
            <Button
              type="text"
              icon={<KeyOutlined />}
              onClick={() => onPassword(user)}
            />
          </Tooltip>
          {user.username !== "admin" && (
            <Tooltip title={t("users.deleteUser")}>
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => onDelete(user)}
              />
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack page-enter">
      <PageToolbar
        eyebrow="users.eyebrow"
        title="users.whoAccessCapability"
        description="users.controlSignMcpAccessMaintain"
        primaryAction={
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            {t("userDialog.createUser")}
          </Button>
        }
        filters={
          <>
            <Input.Search
              allowClear
              className="toolbar-search"
              placeholder={t("connectionsAdmin.searchUsersServers")}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Select
              value={role}
              className="toolbar-select"
              onChange={setRole}
              options={[
                { value: "all", label: t("users.roles") },
                { value: "admin", label: t("common.administrator") },
                { value: "user", label: t("common.standardUser") },
              ]}
            />
            <Segmented
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              options={[
                { value: "all", label: t("common.all") },
                { value: "active", label: t("status.active") },
                { value: "disabled", label: t("status.disabled") },
              ]}
            />
            <Typography.Text type="secondary" className="filter-result-count">
              {t("common.resultCount", { count: filteredUsers.length })}
            </Typography.Text>
          </>
        }
      />

      <Card className="data-card" bordered={false}>
        <Table<AdminUser>
          rowKey="id"
          columns={columns}
          dataSource={filteredUsers}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 820 }}
          locale={{ emptyText: t("overview.noUsers") }}
        />
        <div className="table-summary">
          <TeamOutlined /> {t("users.identitySummary", { total: users.length, active: users.filter((user) => !user.disabled).length })}
        </div>
      </Card>
    </div>
  );
}
