const form = document.querySelector('#setup-form');
const status = document.querySelector('#status');
const steps = [...document.querySelectorAll('[data-step]')];
const progress = [...document.querySelectorAll('#progress li')];
const previous = document.querySelector('#previous');
const next = document.querySelector('#next');
const buttons = [previous, next];
const heading = document.querySelector('#step-heading');
const labels = ['验证部署身份', '连接 PostgreSQL', '连接 Redis', '设置管理员'];
const nextLabels = ['验证并继续', '测试 PostgreSQL 并继续', '测试 Redis 并继续', '保存并启动'];
const paths = ['/setup/verify', '/setup/test-postgres', '/setup/test-redis', '/setup/install'];
let current = 0, busy = false, saved = false;
const message = (text, state = '') => { status.textContent = text; status.dataset.state = state; };
const read = name => form.elements.namedItem(name).value;
const checked = name => form.elements.namedItem(name).checked;
function showStep(index) {
  current = index;
  steps.forEach((step, i) => { step.hidden = i !== index; step.disabled = i !== index; });
  progress.forEach((item, i) => {
    item.classList.toggle('active', i === index);
    item.classList.toggle('done', i < index);
    if (i === index) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  heading.textContent = `第 ${index + 1} / 4 步 · ${labels[index]}`;
  previous.hidden = index === 0;
  next.textContent = nextLabels[index];
}
// Full URLs override structured parameters without requiring their fields.
for (const [url, fields] of [['pgUrl', ['pgHost', 'pgPort', 'pgDatabase', 'pgUsername']], ['redisUrl', ['redisHost', 'redisPort', 'redisDatabase']]]) {
  form.elements.namedItem(url).addEventListener('input', () => {
    for (const field of fields) form.elements.namedItem(field).required = !read(url).trim();
  });
}
function payload() {
  return {
    postgres: { url: read('pgUrl'), host: read('pgHost'), port: read('pgPort'), database: read('pgDatabase'), username: read('pgUsername'), password: read('pgPassword'), tls: checked('pgTls') },
    redis: { url: read('redisUrl'), host: read('redisHost'), port: read('redisPort'), database: read('redisDatabase'), username: read('redisUsername'), password: read('redisPassword'), tls: checked('redisTls') },
    adminUsername: read('adminUsername'), adminPassword: read('adminPassword'),
  };
}
async function advance() {
  if (busy || saved || !form.reportValidity()) return;
  if (current === 3 && read('adminPassword') !== read('adminConfirm')) return message('两次输入的管理员密码不一致。', 'error');
  busy = true;
  buttons.forEach(button => { button.disabled = true; });
  message(current === 3 ? '正在重新校验连接并保存配置…' : `正在${current === 0 ? '验证部署身份' : '测试 ' + (current === 1 ? 'PostgreSQL' : 'Redis')}…`);
  try {
    const response = await fetch(paths[current], {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Token': read('token').trim() },
      body: JSON.stringify(payload()),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
    message(result.message, 'success');
    if (current < 3) {
      showStep(current + 1);
      steps[current].querySelector('input')?.focus();
      return;
    }
    saved = true;
    form.reset();
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const response = await fetch('/healthz', { cache: 'no-store' });
        const health = await response.json();
        if (response.ok && health.ok && health.mode !== 'setup') { location.replace('/'); return; }
      } catch { /* The application is replacing the setup listener. */ }
    }
    message('配置已保存，启动耗时较长。请检查容器日志，然后刷新页面；无需再次提交配置。', 'error');
  } catch (error) { message(error.message || '无法连接应用，请稍后重试。', 'error'); }
  finally { busy = false; if (!saved) buttons.forEach(button => { button.disabled = false; }); }
}
previous.addEventListener('click', () => { if (!busy && !saved) { showStep(current - 1); message(''); } });
form.addEventListener('submit', event => { event.preventDefault(); void advance(); });
showStep(0);
