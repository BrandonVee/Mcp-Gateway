import escapeHtml from 'escape-html';
import { registrationEnabled } from '@mcp/shared';

export type AuthPageLanguage = 'zh-CN' | 'en-US';
export type AuthPageError =
  | 'missingCredentials'
  | 'invalidCredentials'
  | 'invalidUsername'
  | 'invalidPassword'
  | 'passwordMismatch'
  | 'usernameTaken'
  | 'invalidForm'
  | 'tooManyAttempts'
  | 'serviceUnavailable'
  | 'registrationDisabled';
export interface AuthPageDetails {
  clientName: string;
  resourceName?: string;
}

const text = {
  'zh-CN': {
    signInTitle: 'MCP Gateway - 登录',
    signInHeading: '登录并授权',
    signInDescription: '登录你的账号，继续当前客户端的连接。',
    signInSubmit: '登录并授权',
    signupTitle: 'MCP Gateway - 创建账号',
    signupHeading: '创建你的账号',
    signupDescription: '注册后将继续本次授权，无需重新打开客户端。',
    signupSubmit: '创建账号并继续',
    consentTitle: 'MCP Gateway - 授权',
    consentHeading: '授权客户端',
    consentDescription: '确认以下连接信息，完成后将返回客户端。',
    authorize: '确认授权',
    brand: '统一连接入口',
    heroHeading: '一个账号，连接你的 MCP 服务。',
    heroDescription: '登录或创建账号，确认授权，继续在你的客户端中使用工具。',
    stepAccount: '登录账号',
    stepConsent: '确认授权',
    stepReturn: '返回客户端',
    username: '用户名',
    password: '密码',
    confirmPassword: '确认密码',
    usernameHelp: '2–64 个字符，可使用字母、数字、点、下划线和连字符。',
    passwordHelp: '12–256 个字符。',
    usernamePlaceholder: '输入用户名',
    passwordPlaceholder: '输入密码',
    newPasswordPlaceholder: '设置密码',
    confirmPasswordPlaceholder: '再次输入密码',
    noAccount: '还没有账号？',
    createAccount: '创建账号',
    alreadyRegistered: '已有账号？',
    signIn: '返回登录',
    client: '请求客户端',
    resource: '请求服务',
    requestsScope: '请求授权范围',
    signedInAs: '当前用户',
    registered: '账号已创建，请确认授权以完成连接。',
    footer: '完成授权后将返回发起连接的客户端。',
    needsAccess: '当前服务需要管理员开通访问权限。你仍可完成客户端登录。',
    languageMenu: '切换语言',
    missingCredentials: '请输入用户名和密码。',
    invalidCredentials: '用户名或密码错误，或账号已停用。',
    invalidUsername: '用户名须为 2–64 个字母、数字、点、下划线或连字符。',
    invalidPassword: '密码须为 12–256 个字符。',
    passwordMismatch: '两次输入的密码不一致。',
    usernameTaken: '该用户名已被使用，请更换用户名或返回登录。',
    invalidForm: '页面已过期，请重新提交表单。',
    tooManyAttempts: '操作过于频繁，请稍后再试。',
    serviceUnavailable: '暂时无法创建账号，请稍后再试。',
    registrationDisabled: '自行注册已关闭，请登录已有账号，或联系管理员创建账号。',
  },
  'en-US': {
    signInTitle: 'MCP Gateway - Sign in',
    signInHeading: 'Sign in to authorize',
    signInDescription: 'Sign in to continue connecting your client.',
    signInSubmit: 'Sign in and authorize',
    signupTitle: 'MCP Gateway - Create account',
    signupHeading: 'Create your account',
    signupDescription: 'Continue this authorization after signing up, without restarting your client.',
    signupSubmit: 'Create account and continue',
    consentTitle: 'MCP Gateway - Authorize',
    consentHeading: 'Authorize client',
    consentDescription: 'Review this connection before returning to your client.',
    authorize: 'Authorize',
    brand: 'One place to connect',
    heroHeading: 'One account. Your MCP services.',
    heroDescription: 'Sign in or create an account, approve the connection, and continue using tools in your client.',
    stepAccount: 'Sign in',
    stepConsent: 'Authorize',
    stepReturn: 'Return to client',
    username: 'Username',
    password: 'Password',
    confirmPassword: 'Confirm password',
    usernameHelp: '2–64 letters, numbers, dots, underscores, or hyphens.',
    passwordHelp: '12–256 characters.',
    usernamePlaceholder: 'Enter your username',
    passwordPlaceholder: 'Enter your password',
    newPasswordPlaceholder: 'Choose a password',
    confirmPasswordPlaceholder: 'Repeat your password',
    noAccount: 'New here?',
    createAccount: 'Create an account',
    alreadyRegistered: 'Already have an account?',
    signIn: 'Back to sign in',
    client: 'Requesting client',
    resource: 'Requested service',
    requestsScope: 'Requested scope',
    signedInAs: 'Signed in as',
    registered: 'Account created. Authorize the connection to continue.',
    footer: 'After authorization, you will return to the client that requested this connection.',
    needsAccess: 'An administrator needs to grant access to this service. You can still complete client sign-in.',
    languageMenu: 'Select language',
    missingCredentials: 'Enter your username and password.',
    invalidCredentials: 'Invalid username or password, or account disabled.',
    invalidUsername: 'Use 2–64 letters, numbers, dots, underscores, or hyphens for your username.',
    invalidPassword: 'Use a password with 12–256 characters.',
    passwordMismatch: 'The passwords do not match.',
    usernameTaken: 'This username is already in use. Choose another or sign in.',
    invalidForm: 'This page has expired. Please submit the form again.',
    tooManyAttempts: 'Too many attempts. Please try again later.',
    serviceUnavailable: 'Unable to create an account right now. Please try again later.',
    registrationDisabled:
      'Self-registration is closed. Sign in to an existing account or ask an administrator to create one.',
  },
} as const;

export function pageLanguage(requested: string | undefined, acceptLanguage: string | undefined): AuthPageLanguage {
  if (requested === 'zh-CN' || requested === 'en-US') return requested;
  const preferences = (acceptLanguage ?? '')
    .split(',')
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(';');
      const quality = parameters.find((parameter) => /^q=/i.test(parameter.trim()));
      const weight = quality ? Number(quality.trim().slice(2)) : 1;
      return {
        tag: tag.toLowerCase(),
        weight: Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0,
        index,
      };
    })
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const preference of preferences) {
    if (preference.weight === 0) continue;
    if (/^zh(?:-|$)/.test(preference.tag)) return 'zh-CN';
    if (/^en(?:-|$)/.test(preference.tag)) return 'en-US';
  }
  return 'en-US';
}

const FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const;
export function authorizationParams(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    FIELDS.map((key) => [key, typeof input[key] === 'string' ? input[key] : key === 'scope' ? 'mcp' : '']),
  );
}

export function authorizationLink(
  path: '/authorize' | '/authorize/signup',
  q: Record<string, string>,
  language: AuthPageLanguage,
): string {
  const params = new URLSearchParams(authorizationParams(q));
  params.set('lang', language);
  return `${path}?${params}`;
}

// OAuth parameters and user names land in both element text and quoted
// attributes, so every interpolation goes through an HTML escaper.
function esc(value: string): string {
  return escapeHtml(value);
}
function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}
function hiddenFields(q: Record<string, string>, language: AuthPageLanguage): string {
  return [
    hidden('lang', language),
    ...Object.entries(authorizationParams(q)).map(([key, value]) => hidden(key, value)),
  ].join('\n');
}

const STYLE = `<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf5ff;background:#070b13;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100svh;background:radial-gradient(ellipse at 12% 30%,#132a4a 0,transparent 48%),radial-gradient(ellipse at 96% 88%,#0b2430 0,transparent 42%),#070b13}
a{color:#7cbcff;text-decoration:none}a:hover{color:#b7dcff;text-decoration:underline}a:focus-visible,button:focus-visible{outline:3px solid #7cbcff;outline-offset:4px}
.page{width:min(1080px,100%);margin:auto;padding:34px 40px 48px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px}.brand{display:flex;align-items:center;gap:12px}.brand strong{display:block;font-size:16px;letter-spacing:-.3px}.brand small{display:block;color:#8292aa;font-size:12px;margin-top:3px}.mark{width:38px;height:38px;border-radius:11px;background:linear-gradient(145deg,#36a3ff,#2464f0 55%,#183ca3);display:grid;place-items:center;box-shadow:0 8px 24px #2464f02b}.mark svg{width:23px;height:23px}
.languages{display:flex;align-items:center;gap:14px;font-size:12px}.languages strong{color:#edf5ff}.languages a{color:#8292aa}.layout{display:grid;grid-template-columns:1fr 430px;gap:70px;align-items:center;min-height:calc(100svh - 160px);padding:50px 0 24px}.hero{padding:0 0 22px}.eyebrow{display:inline-flex;align-items:center;gap:8px;color:#8acbff;font-size:12px;letter-spacing:1.5px}.dot{width:7px;height:7px;background:#5df6cc;border-radius:50%;box-shadow:0 0 14px #20d99a70}.hero h1{font-size:clamp(32px,4vw,47px);line-height:1.22;font-weight:650;letter-spacing:-1.5px;margin:22px 0;max-width:450px}.hero>p{color:#9cadc2;line-height:1.9;font-size:15px;max-width:380px;margin:0}.steps{display:flex;gap:20px;margin-top:38px;color:#8292aa;font-size:12px}.steps span{display:flex;flex-direction:column;gap:9px}.steps b{font-size:11px;color:#6eb5ff;font-weight:500}.steps i{width:22px;height:1px;background:#284264;margin-top:6px}
.card{background:linear-gradient(155deg,#111c2b,#0c1422);border:1px solid #25354c;border-radius:22px;padding:32px;box-shadow:0 24px 80px #0005}.card h2{font-size:26px;letter-spacing:-.6px;margin:0 0 10px;font-weight:650}.description{font-size:13px;line-height:1.8;color:#9cadc2;margin:0 0 23px}.request{margin:0 0 25px;padding:15px 16px;border:1px solid #22334b;border-radius:12px;background:#080f1b90}.request div{display:grid;grid-template-columns:94px minmax(0,1fr);gap:10px;font-size:12px;line-height:1.65}.request div+div{margin-top:8px}.request dt{color:#8292aa}.request dd{margin:0;color:#d5e6fc;overflow-wrap:anywhere}.request .resource-url{display:block;color:#8292aa;font-size:11px;margin-top:3px}
.field{margin-bottom:18px}.field label{display:block;font-size:13px;color:#d5e6fc;margin-bottom:8px}.field input{display:block;width:100%;height:46px;background:#080f1b;color:#edf5ff;border:1px solid #2a3a51;border-radius:9px;padding:0 13px;font:inherit;font-size:14px;transition:border-color .15s,box-shadow .15s}.field input::placeholder{color:#60728a}.field input:focus{outline:0;border-color:#469cff;box-shadow:0 0 0 3px #2f8cff20}.field small{display:block;font-size:11px;line-height:1.6;color:#8292aa;margin-top:7px}
.submit{display:flex;justify-content:center;align-items:center;gap:10px;width:100%;min-height:46px;margin-top:24px;border:1px solid #67b4ff44;border-radius:9px;color:white;background:linear-gradient(120deg,#328eff,#2464ed);font:inherit;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px #2464f023}.submit:hover{filter:brightness(1.12)}.submit svg{width:16px;height:16px}.alternate{text-align:center;color:#8292aa;font-size:13px;line-height:1.8;margin:23px 0 0;padding-top:22px;border-top:1px solid #22334b}.alternate a{margin-left:7px}.notice{font-size:13px;line-height:1.7;border-radius:9px;padding:12px 14px;margin:0 0 20px}.error{background:#ff5d7310;border:1px solid #ff5d7340;color:#ffb1bd}.success{background:#20d99a10;border:1px solid #20d99a35;color:#8ce7c5}.account{display:flex;align-items:center;gap:12px;padding:13px 0 23px;color:#9cadc2;font-size:12px}.avatar{width:38px;height:38px;display:grid;place-items:center;border-radius:50%;background:#2f8cff20;color:#7cbcff;font-size:15px}.account strong{display:block;font-size:15px;color:#edf5ff;margin-top:3px;overflow-wrap:anywhere}.footer{text-align:center;font-size:11px;color:#6c7e97;line-height:1.8;padding:0 12px}
@media(max-width:850px){.page{max-width:500px;padding:24px 20px 32px}.layout{grid-template-columns:1fr;gap:28px;min-height:0;padding-top:40px}.hero{padding:0}.hero h1{font-size:30px;margin:14px 0;max-width:none;letter-spacing:-.8px}.hero>p{font-size:13px;max-width:none}.steps{display:none}.card{padding:26px}.footer{margin-top:24px}.brand small{display:none}.languages{gap:10px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>`;

const MARK =
  '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1"/><rect x="19" y="5" width="8" height="8" rx="1"/><rect x="5" y="19" width="8" height="8" rx="1"/><rect x="19" y="19" width="8" height="8" rx="1"/></svg>';
const ARROW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';

function shell(
  title: string,
  q: Record<string, string>,
  language: AuthPageLanguage,
  content: string,
  path: '/authorize' | '/authorize/signup',
): string {
  const copy = text[language];
  const languageLink = (target: AuthPageLanguage, label: string) =>
    target === language
      ? `<strong aria-current="true">${label}</strong>`
      : `<a href="${esc(authorizationLink(path, q, target))}">${label}</a>`;
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#070b13"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><title>${title}</title>${STYLE}</head>
<body><main class="page"><header class="topbar"><div class="brand"><span class="mark">${MARK}</span><span><strong>MCP Gateway</strong><small>${copy.brand}</small></span></div><nav class="languages" aria-label="${copy.languageMenu}">${languageLink('zh-CN', '中文')}${languageLink('en-US', 'English')}</nav></header>
<div class="layout"><section class="hero"><span class="eyebrow"><i class="dot"></i>MCP GATEWAY</span><h1>${copy.heroHeading}</h1><p>${copy.heroDescription}</p><div class="steps"><span><b>01</b>${copy.stepAccount}</span><i></i><span><b>02</b>${copy.stepConsent}</span><i></i><span><b>03</b>${copy.stepReturn}</span></div></section><section class="card" aria-labelledby="page-title">${content}</section></div><footer class="footer">${copy.footer}</footer></main></body></html>`;
}

function requestDetails(q: Record<string, string>, details: AuthPageDetails, language: AuthPageLanguage): string {
  const copy = text[language];
  return `<dl class="request"><div><dt>${copy.client}</dt><dd>${esc(details.clientName)}</dd></div>${q.resource ? `<div><dt>${copy.resource}</dt><dd>${esc(details.resourceName || q.resource)}${details.resourceName ? `<small class="resource-url">${esc(q.resource)}</small>` : ''}</dd></div>` : ''}<div><dt>${copy.requestsScope}</dt><dd>${esc(q.scope || 'mcp')}</dd></div></dl>`;
}

function errorNotice(error: AuthPageError | undefined, language: AuthPageLanguage): string {
  return error ? `<p class="notice error" role="alert">${text[language][error]}</p>` : '';
}

export function loginPage(
  q: Record<string, string>,
  language: AuthPageLanguage,
  details: AuthPageDetails,
  error?: AuthPageError,
  username = '',
): string {
  const copy = text[language];
  return shell(
    copy.signInTitle,
    q,
    language,
    `<h2 id="page-title">${copy.signInHeading}</h2><p class="description">${copy.signInDescription}</p>${requestDetails(q, details, language)}${errorNotice(error, language)}
<form method="post" action="/authorize/submit">${hiddenFields(q, language)}
<div class="field"><label for="username">${copy.username}</label><input id="username" name="username" autocomplete="username" placeholder="${copy.usernamePlaceholder}" value="${esc(username)}" maxlength="64" required></div>
<div class="field"><label for="password">${copy.password}</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="${copy.passwordPlaceholder}" required></div>
<button class="submit" type="submit">${copy.signInSubmit}${ARROW}</button></form>
${registrationEnabled() ? `<p class="alternate">${copy.noAccount}<a href="${esc(authorizationLink('/authorize/signup', q, language))}">${copy.createAccount}</a></p>` : ''}`,
    '/authorize',
  );
}

export function signupPage(
  q: Record<string, string>,
  language: AuthPageLanguage,
  details: AuthPageDetails,
  csrfToken: string,
  error?: AuthPageError,
  username = '',
): string {
  const copy = text[language];
  return shell(
    copy.signupTitle,
    q,
    language,
    `<h2 id="page-title">${copy.signupHeading}</h2><p class="description">${copy.signupDescription}</p>${requestDetails(q, details, language)}${errorNotice(error, language)}
<form method="post" action="/authorize/signup">${hiddenFields(q, language)}${hidden('form_token', csrfToken)}
<div class="field"><label for="username">${copy.username}</label><input id="username" name="username" autocomplete="username" placeholder="${copy.usernamePlaceholder}" value="${esc(username)}" minlength="2" maxlength="64" pattern="[a-zA-Z0-9._\\-]{2,64}" aria-describedby="username-help" required><small id="username-help">${copy.usernameHelp}</small></div>
<div class="field"><label for="password">${copy.password}</label><input id="password" name="password" type="password" autocomplete="new-password" placeholder="${copy.newPasswordPlaceholder}" minlength="12" maxlength="256" aria-describedby="password-help" required><small id="password-help">${copy.passwordHelp}</small></div>
<div class="field"><label for="confirm-password">${copy.confirmPassword}</label><input id="confirm-password" name="confirm_password" type="password" autocomplete="new-password" placeholder="${copy.confirmPasswordPlaceholder}" minlength="12" maxlength="256" required></div>
<button class="submit" type="submit">${copy.signupSubmit}${ARROW}</button></form>
<p class="alternate">${copy.alreadyRegistered}<a href="${esc(authorizationLink('/authorize', q, language))}">${copy.signIn}</a></p>`,
    '/authorize/signup',
  );
}

export function consentPage(
  q: Record<string, string>,
  user: string,
  language: AuthPageLanguage,
  details: AuthPageDetails,
  registered = false,
  needsAccess = false,
): string {
  const copy = text[language];
  return shell(
    copy.consentTitle,
    q,
    language,
    `<h2 id="page-title">${copy.consentHeading}</h2><p class="description">${copy.consentDescription}</p>${registered ? `<p class="notice success" role="status">${copy.registered}</p>` : ''}
<div class="account"><span class="avatar" aria-hidden="true">${esc(user.slice(0, 1).toUpperCase())}</span><span>${copy.signedInAs}<strong>${esc(user)}</strong></span></div>${requestDetails(q, details, language)}${needsAccess ? `<p class="notice" role="status">${copy.needsAccess}</p>` : ''}
<form method="post" action="/authorize/submit">${hiddenFields(q, language)}<button class="submit" type="submit">${copy.authorize}${ARROW}</button></form>`,
    '/authorize',
  );
}
