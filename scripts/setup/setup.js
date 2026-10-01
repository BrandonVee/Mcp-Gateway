const form = document.querySelector('#setup-form');
const status = document.querySelector('#status');
const buttons = [...document.querySelectorAll('button')];
const message = (text, state = '') => { status.textContent = text; status.dataset.state = state; };
const read = name => form.elements.namedItem(name).value;
const checked = name => form.elements.namedItem(name).checked;
// Full URLs override structured parameters without requiring their fields.
for (const [url, fields] of [['pgUrl', ['pgHost', 'pgPort', 'pgDatabase', 'pgUsername']], ['redisUrl', ['redisHost', 'redisPort', 'redisDatabase']]]) {
  form.elements.namedItem(url).addEventListener('input', () => {
    for (const field of fields) form.elements.namedItem(field).required = !read(url).trim();
  });
}
let saved = false;
async function submit(install) {
  if (!form.reportValidity()) return;
  if (read('adminPassword') !== read('adminConfirm')) return message('两次输入的管理员密码不一致。', 'error');
  buttons.forEach(button => { button.disabled = true; });
  message(install ? '正在校验连接并保存配置…' : '正在测试 PostgreSQL 与 Redis…');
  try {
    const response = await fetch(install ? '/setup/install' : '/setup/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Token': read('token').trim() },
      body: JSON.stringify({
        postgres: { url: read('pgUrl'), host: read('pgHost'), port: read('pgPort'), database: read('pgDatabase'), username: read('pgUsername'), password: read('pgPassword'), tls: checked('pgTls') },
        redis: { url: read('redisUrl'), host: read('redisHost'), port: read('redisPort'), database: read('redisDatabase'), username: read('redisUsername'), password: read('redisPassword'), tls: checked('redisTls') },
        adminUsername: read('adminUsername'), adminPassword: read('adminPassword'),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
    message(result.message, 'success');
    if (install) {
      saved = true;
      form.reset();
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try { const response = await fetch('/healthz', { cache: 'no-store' }); const health = await response.json(); if (response.ok && health.ok && health.mode !== 'setup') { location.replace('/'); return; } } catch { /* The application is replacing the setup listener. */ }
      }
      message('配置已保存，启动耗时较长。请检查容器日志，然后刷新页面；无需再次提交配置。', 'error');
      return;
    }
  } catch (error) { message(error.message || '无法连接应用，请稍后重试。', 'error'); }
  finally { if (!saved) buttons.forEach(button => { button.disabled = false; }); }
}
document.querySelector('#test').addEventListener('click', () => submit(false));
form.addEventListener('submit', event => { event.preventDefault(); void submit(true); });
