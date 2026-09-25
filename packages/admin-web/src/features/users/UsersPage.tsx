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
      title: "用户",
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
            <small>ID / {String(user.id).padStart(4, "0")}</small>
          </span>
        </Flex>
      ),
    },
    {
      title: "角色",
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
          {role === "admin" ? "管理员" : "普通用户"}
        </Tag>
      ),
    },
    {
      title: "Server 访问范围",
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
                {name === "*" ? user.role === "admin" ? "管理员 · 全部 Server" : "全部 Server（*）" : name}
              </Tag>
            ))
          ) : (
            <Typography.Text type="secondary">尚未授权</Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      title: "用户认证",
      dataIndex: "disabled",
      key: "disabled",
      width: 150,
      render: (disabled: boolean, user) => (
        <Switch
          checked={!disabled}
          checkedChildren="允许登录"
          unCheckedChildren="禁止登录"
          disabled={user.username === "admin"}
          onChange={() => onToggle(user)}
        />
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 156,
      align: "right",
      render: (_, user) => (
        <Space size={4}>
          {user.role === "user" && <Tooltip title="分配权限">
            <Button
              type="text"
              icon={<LinkOutlined />}
              onClick={() => onAssign(user)}
            />
          </Tooltip>}
          <Tooltip title="重置密码">
            <Button
              type="text"
              icon={<KeyOutlined />}
              onClick={() => onPassword(user)}
            />
          </Tooltip>
          {user.username !== "admin" && (
            <Tooltip title="删除用户">
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
        eyebrow="IDENTITY DIRECTORY"
        title="谁可以访问哪些能力"
        description="开关用户登录与 MCP 访问，并维护每个 Server 的授权范围。"
        primaryAction={
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            创建用户
          </Button>
        }
        filters={
          <>
            <Input.Search
              allowClear
              className="toolbar-search"
              placeholder="搜索用户或 Server"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Select
              value={role}
              className="toolbar-select"
              onChange={setRole}
              options={[
                { value: "all", label: "全部角色" },
                { value: "admin", label: "管理员" },
                { value: "user", label: "普通用户" },
              ]}
            />
            <Segmented
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              options={[
                { value: "all", label: "全部" },
                { value: "active", label: "可用" },
                { value: "disabled", label: "已禁用" },
              ]}
            />
            <Typography.Text type="secondary" className="filter-result-count">
              {filteredUsers.length} 条结果
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
          locale={{ emptyText: "暂无用户" }}
        />
        <div className="table-summary">
          <TeamOutlined /> 共 {users.length} 个身份，其中{" "}
          {users.filter((user) => !user.disabled).length} 个可用
        </div>
      </Card>
    </div>
  );
}
