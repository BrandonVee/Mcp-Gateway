import {
  ArrowRightOutlined,
  LockOutlined,
  MailOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Divider, Form, Input, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '@/web/api';
import { useI18n } from '@/web/i18n';
import { LanguageSwitcher } from '@/web/components/LanguageSwitcher';
import { BrandMark } from '@/web/components/BrandMark';
import { ThemeSwitcher } from '@/web/components/ThemeSwitcher';
import type { PlatformSession } from '@/web/types';

interface LoginForm {
  username: string;
  password: string;
}

interface SignupForm {
  verificationCode?: string;
  email: string;
  password: string;
  confirmation: string;
}

export function LoginPage({
  onSuccess,
  registrationEnabled,
  emailVerificationRequired,
}: {
  onSuccess: (session: PlatformSession) => void;
  registrationEnabled?: boolean;
  emailVerificationRequired?: boolean;
}) {
  const { t } = useI18n();
  const [signupForm] = Form.useForm<SignupForm>();
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);
  useEffect(() => {
    if (!codeCooldown) return;
    const timer = window.setTimeout(() => setCodeCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [codeCooldown]);
  const sendCode = async () => {
    try {
      await signupForm.validateFields(['email']);
    } catch {
      return;
    }
    setSendingCode(true);
    setError('');
    try {
      await api.signupSendCode(signupForm.getFieldValue('email').trim());
      setCodeCooldown(60);
      setCodeSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('common.operationFailed'));
    } finally {
      setSendingCode(false);
    }
  };
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
      const session = await api.mySignup(
        values.email,
        values.email,
        values.password,
        values.confirmation,
        values.verificationCode,
      );
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
          <BrandMark className="login-brand-mark" size={40} />
          <span>
            <strong>{t('app.documentTitle')}</strong>
            <small>{t('auth.unifiedControlPlane')}</small>
          </span>
        </div>

        <div className="story-content">
          <Typography.Title>
            {t('auth.oneEntryPointControlEvery')}
            <em>{t('auth.capabilityPath')}</em>
          </Typography.Title>
          <div className="story-steps">
            {(
              [
                ['auth.stepAuthentication', 'auth.stepAuthenticationDescription'],
                ['auth.stepRouting', 'auth.stepRoutingDescription'],
                ['auth.stepObservability', 'auth.stepObservabilityDescription'],
              ] as const
            ).map(([label, description]) => (
              <div key={label}>
                <strong>{t(label)}</strong>
                <small>{t(description)}</small>
              </div>
            ))}
          </div>
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
              form={signupForm}
              name="signup"
              layout="vertical"
              initialValues={{ email: '', password: '', confirmation: '' }}
              disabled={busy}
              onFinish={register}
              requiredMark={false}
            >
              <Form.Item
                name="email"
                label={t('auth.signup.emailLabel')}
                rules={[
                  { required: true, message: t('auth.signup.emailRequired') },
                  { type: 'email', message: t('auth.signup.emailRule') },
                ]}
              >
                <Input prefix={<MailOutlined />} placeholder={t('auth.signup.emailPlaceholder')} autoComplete="email" />
              </Form.Item>
              {emailVerificationRequired && (
                <>
                  <Form.Item
                    name="verificationCode"
                    label={t('auth.signup.codeLabel')}
                    rules={[
                      { required: true, message: t('auth.signup.codeRequired') },
                      { pattern: /^\d{6}$/, message: t('auth.signup.invalidCode') },
                    ]}
                  >
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      addonAfter={
                        <Button
                          type="link"
                          disabled={codeCooldown > 0 || busy}
                          loading={sendingCode}
                          onClick={() => void sendCode()}
                        >
                          {codeCooldown
                            ? t('auth.signup.resendCountdown', { seconds: codeCooldown })
                            : t('auth.signup.sendCode')}
                        </Button>
                      }
                    />
                  </Form.Item>
                  {codeSent && <Alert type="success" showIcon message={t('auth.signup.codeSent')} />}
                </>
              )}
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
        </Card>
      </section>
    </main>
  );
}
