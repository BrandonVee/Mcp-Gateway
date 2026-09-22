import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Divider,
  Form,
  Input,
  Space,
  Typography,
} from "antd";
import { useState } from "react";
import { api } from "../../api";

interface LoginForm {
  username: string;
  password: string;
}

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [error, setError] = useState("");

  const submit = async (values: LoginForm) => {
    setError("");
    try {
      await api.login(values.username, values.password);
      onSuccess();
    } catch {
      setError("凭据无效，或该账号没有管理员权限。");
    }
  };

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="story-glow" />
        <div className="login-brand">
          <span className="login-brand-mark">
            <CloudServerOutlined />
          </span>
          <span>
            <strong>MCP Console</strong>
            <small>UNIFIED CONTROL PLANE</small>
          </span>
        </div>

        <div className="story-content">
          <Typography.Text className="story-index">
            01 / CONTROL SURFACE
          </Typography.Text>
          <Typography.Title>
            一处接入，掌控每一条
            <em>能力链路</em>
          </Typography.Title>
          <Typography.Paragraph>
            统一编排身份、Server 路由与实例健康，让每一条 MCP
            连接都有清晰的归属与边界。
          </Typography.Paragraph>
          <div className="story-steps">
            {[
              ["AUTH", "统一身份签发"],
              ["ROUTE", "动态路由发现"],
              ["OBSERVE", "实时状态观测"],
            ].map(([label, description], index) => (
              <div key={label}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{label}</strong>
                <small>{description}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="story-status">
          <CheckCircleFilled /> PostgreSQL · Redis · OAuth 2.1
        </div>
      </section>

      <section className="login-form-area">
        <Card className="login-card" bordered={false}>
          <Space direction="vertical" size={4} className="login-card-heading">
            <div className="secure-icon">
              <SafetyCertificateOutlined />
            </div>
            <Typography.Title level={2}>欢迎回来</Typography.Title>
            <Typography.Text type="secondary">
              使用管理员凭据进入控制平面
            </Typography.Text>
          </Space>

          <Divider />

          <Form<LoginForm>
            layout="vertical"
            initialValues={{ username: "admin", password: "" }}
            onFinish={submit}
            requiredMark={false}
          >
            <Form.Item
              name="username"
              label="管理员账号"
              rules={[{ required: true, message: "请输入管理员账号" }]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder="输入账号"
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              label="访问密码"
              rules={[{ required: true, message: "请输入访问密码" }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="输入密码"
                autoComplete="current-password"
              />
            </Form.Item>

            {error && (
              <Alert
                type="error"
                message={error}
                showIcon
                className="login-error"
              />
            )}

            <Form.Item className="login-submit">
              <Button type="primary" htmlType="submit" block size="large">
                验证并进入 <ArrowRightOutlined />
              </Button>
            </Form.Item>
          </Form>

          <div className="login-hint">
            <LockOutlined /> 管理会话通过 HttpOnly Cookie 安全传输
          </div>
        </Card>
      </section>
    </main>
  );
}
