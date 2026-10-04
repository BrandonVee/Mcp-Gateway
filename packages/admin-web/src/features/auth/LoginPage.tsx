import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Divider, Form, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { ThemeSwitcher } from '../../components/ThemeSwitcher';
import type { PlatformSession } from '../../types';

interface LoginForm {
  username: string;
  password: string;
}

interface SignupForm {
  username: string;
  password: string;
  confirmation: string;
}

export function LoginPage({
  onSuccess,
  registrationEnabled,
}: {
  onSuccess: (session: PlatformSession) => void;
  registrationEnabled?: boolean;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const switchMode = (next: 'login' | 'signup') => {
    setMode(next);
    setError('');
  };

  const submit = async (values: LoginForm) => {
    setError('');
    setBusy(true);
    try {
      const session = await api.myLogin(values.username, values.password);
      onSuccess(session);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('auth.login.invalidCredentials'));
    } finally {
      setBusy(false);
    }
  };

  const register = async (values: SignupForm) => {
    setError('');
    setBusy(true);
    try {
      const session = await api.mySignup(values.username, values.password, values.confirmation);
      onSuccess(session);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('common.operationFailed'));
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
            <strong>{t('app.documentTitle')}</strong>
            <small>{t('auth.unifiedControlPlane')}</small>
          </span>
        </div>

        <div className="story-content">
          <Typography.Text className="story-index">{t('auth.controlSurfaceStep')}</Typography.Text>
          <Typography.Title>
            {t('auth.oneEntryPointControlEvery')}
            <em>{t('auth.capabilityPath')}</em>
          </Typography.Title>
          <Typography.Paragraph>{t('auth.unifyIdentityServerRoutingInstance')}</Typography.Paragraph>
          <div className="story-steps">
            {(
              [
                ['auth.stepAuthentication', 'auth.unifiedIdentity'],
                ['auth.stepRouting', 'auth.dynamicRouting'],
                ['auth.stepObservability', 'auth.liveObservability'],
              ] as const
            ).map(([label, description], index) => (
              <div key={label}>
                <span>{String(index + 1).padStart(2, '0')}</span>
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
        <div className="login-preferences">
          <ThemeSwitcher />
          <LanguageSwitcher compact />
        </div>
        <Card className="login-card" bordered={false}>
          <Space direction="vertical" size={4} className="login-card-heading">
            <div className="secure-icon">
              <SafetyCertificateOutlined />
            </div>
            <Typography.Title level={2}>
              {mode === 'login' ? t('auth.login.title') : t('auth.signup.title')}
            </Typography.Title>
            <Typography.Text type="secondary">
              {mode === 'login' ? t('auth.login.subtitle') : t('auth.signup.subtitle')}
            </Typography.Text>
          </Space>

          <Divider />

          {mode === 'login' ? (
            <Form<LoginForm>
              key="login"
              name="login"
              layout="vertical"
              initialValues={{ username: '', password: '' }}
              disabled={busy}
              onFinish={submit}
              requiredMark={false}
            >
              <Form.Item
                name="username"
                label={t('auth.login.usernameLabel')}
                rules={[{ required: true, message: t('auth.login.usernameRequired') }]}
              >
                <Input
                  prefix={<UserOutlined />}
                  placeholder={t('auth.login.usernamePlaceholder')}
                  autoComplete="username"
                />
              </Form.Item>
              <Form.Item
                name="password"
                label={t('auth.login.passwordLabel')}
                rules={[{ required: true, message: t('auth.login.passwordRequired') }]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder={t('auth.login.passwordPlaceholder')}
                  autoComplete="current-password"
                />
              </Form.Item>

              {error && <Alert type="error" message={error} showIcon className="login-error" />}

              <Form.Item className="login-submit">
                <Button type="primary" htmlType="submit" block size="large" loading={busy}>
                  {t('auth.login.submit')} <ArrowRightOutlined />
                </Button>
              </Form.Item>
            </Form>
          ) : (
            <Form<SignupForm>
              key="signup"
              name="signup"
              layout="vertical"
              initialValues={{ username: '', password: '', confirmation: '' }}
              disabled={busy}
              onFinish={register}
              requiredMark={false}
            >
              <Form.Item
                name="username"
                label={t('auth.signup.usernameLabel')}
                extra={t('auth.signup.usernameRule')}
                rules={[
                  { required: true, message: t('auth.signup.usernameRequired') },
                  { pattern: /^[a-zA-Z0-9._-]{2,64}$/, message: t('auth.signup.usernameRule') },
                ]}
              >
                <Input
                  prefix={<UserOutlined />}
                  placeholder={t('auth.signup.usernamePlaceholder')}
                  autoComplete="username"
                />
              </Form.Item>
              <Form.Item
                name="password"
                label={t('auth.signup.passwordLabel')}
                extra={t('auth.signup.passwordRule')}
                rules={[
                  { required: true, message: t('auth.signup.passwordRequired') },
                  { min: 12, max: 256, message: t('auth.signup.passwordRule') },
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder={t('auth.signup.passwordPlaceholder')}
                  autoComplete="new-password"
                />
              </Form.Item>
              <Form.Item
                name="confirmation"
                label={t('auth.signup.confirmLabel')}
                dependencies={['password']}
                rules={[
                  { required: true, message: t('auth.signup.confirmRequired') },
                  ({ getFieldValue }) => ({
                    validator: (_rule, value) =>
                      !value || value === getFieldValue('password')
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('auth.signup.mismatch'))),
                  }),
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder={t('auth.signup.confirmPlaceholder')}
                  autoComplete="new-password"
                />
              </Form.Item>

              {error && <Alert type="error" message={error} showIcon className="login-error" />}

              <Form.Item className="login-submit">
                <Button type="primary" htmlType="submit" block size="large" loading={busy}>
                  {t('auth.signup.submit')} <ArrowRightOutlined />
                </Button>
              </Form.Item>
            </Form>
          )}

          <div className="login-switch">
            {mode === 'signup' ? (
              <Button type="link" onClick={() => switchMode('login')} disabled={busy}>
                {t('auth.signup.switchToLogin')}
              </Button>
            ) : registrationEnabled ? (
              <Button disabled={busy} type="link" onClick={() => switchMode('signup')}>
                {t('auth.signup.switchToSignup')}
              </Button>
            ) : null}
          </div>

          <div className="login-hint">
            <LockOutlined /> {t('auth.adminSessionsUseSecureHttponly')}
          </div>
        </Card>
      </section>
    </main>
  );
}
