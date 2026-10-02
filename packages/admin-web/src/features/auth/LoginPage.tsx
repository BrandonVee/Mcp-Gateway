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
import { useI18n } from "../../i18n";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import type { PlatformSession } from "../../types";

interface LoginForm {
  username: string;
  password: string;
}

export function LoginPage({ onSuccess }: { onSuccess: (session: PlatformSession) => void }) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (values: LoginForm) => {
    setError("");
    setBusy(true);
    try {
      const session = await api.myLogin(values.username, values.password);
      onSuccess(session);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("auth.login.invalidCredentials"));
    } finally {
      setBusy(false);
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
            <strong>{t("app.documentTitle")}</strong>
            <small>{t("auth.unifiedControlPlane")}</small>
          </span>
        </div>

        <div className="story-content">
          <Typography.Text className="story-index">
            {t("auth.controlSurfaceStep")}
          </Typography.Text>
          <Typography.Title>
            {t("auth.oneEntryPointControlEvery")}
            <em>{t("auth.capabilityPath")}</em>
          </Typography.Title>
          <Typography.Paragraph>
            {t("auth.unifyIdentityServerRoutingInstance")}
          </Typography.Paragraph>
          <div className="story-steps">
            {([
              ["auth.stepAuthentication", "auth.unifiedIdentity"],
              ["auth.stepRouting", "auth.dynamicRouting"],
              ["auth.stepObservability", "auth.liveObservability"],
            ] as const).map(([label, description], index) => (
              <div key={label}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{t(label)}</strong>
                <small>{t(description)}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="story-status">
          <CheckCircleFilled /> PostgreSQL · Redis · OAuth 2.1
        </div>
      </section>

      <section className="login-form-area">
        <LanguageSwitcher compact />
        <Card className="login-card" bordered={false}>
          <Space direction="vertical" size={4} className="login-card-heading">
            <div className="secure-icon">
              <SafetyCertificateOutlined />
            </div>
            <Typography.Title level={2}>{t("auth.login.title")}</Typography.Title>
            <Typography.Text type="secondary">
              {t("auth.login.subtitle")}
            </Typography.Text>
          </Space>

          <Divider />

          <Form<LoginForm>
            layout="vertical"
            initialValues={{ username: "", password: "" }}
            disabled={busy}
            onFinish={submit}
            requiredMark={false}
          >
            <Form.Item
              name="username"
              label={t("auth.login.usernameLabel")}
              rules={[{ required: true, message: t("auth.login.usernameRequired") }]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder={t("auth.login.usernamePlaceholder")}
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              label={t("auth.login.passwordLabel")}
              rules={[{ required: true, message: t("auth.login.passwordRequired") }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder={t("auth.login.passwordPlaceholder")}
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
              <Button type="primary" htmlType="submit" block size="large" loading={busy}>
                {t("auth.login.submit")} <ArrowRightOutlined />
              </Button>
            </Form.Item>
          </Form>

          <div className="login-hint">
            <LockOutlined /> {t("auth.adminSessionsUseSecureHttponly")}
          </div>
        </Card>
      </section>
    </main>
  );
}
