import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// A minimal browser surface executes the actual script, including form validity
// for hidden steps, navigation and network failures. No copied wizard logic.
function browser() {
  const html = readFileSync('scripts/setup/index.html', 'utf8');
  const inputs = new Map<string, any>();
  const handlers: Record<string, (...args: any[]) => any> = {};
  const steps = [...html.matchAll(/<fieldset data-step="\d"[^>]*>([\s\S]*?)<\/fieldset>/g)].map((match) => {
    const fields = [...match[1].matchAll(/<input ([^>]+)>/g)].map((field) => {
      const attributes = field[1];
      const name = attributes.match(/name="([^"]+)"/)![1];
      const value = {
        value: attributes.match(/value="([^"]*)"/)?.[1] || '',
        checked: false,
        required: /\brequired\b/.test(attributes),
        addEventListener: (type: string, fn: any) => {
          handlers[name + ':' + type] = fn;
        },
        focus: () => {},
      };
      inputs.set(name, value);
      return value;
    });
    return { disabled: false, hidden: false, fields, querySelector: () => fields[0] };
  });
  const elements = new Map<string, any>();
  for (const name of ['previous', 'next', 'status', 'step-heading'])
    elements.set('#' + name, {
      hidden: false,
      disabled: false,
      textContent: '',
      dataset: {},
      addEventListener: (type: string, fn: any) => {
        handlers[name + ':' + type] = fn;
      },
    });
  elements.set('#setup-form', {
    elements: { namedItem: (name: string) => inputs.get(name) },
    reportValidity: () =>
      steps.every((step) => step.disabled || step.fields.every((field) => !field.required || field.value)),
    reset: () =>
      inputs.forEach((field) => {
        field.value = '';
      }),
    addEventListener: (type: string, fn: any) => {
      handlers['form:' + type] = fn;
    },
  });
  const requests: any[] = [];
  let success = true;
  const progress = steps.map(() => ({
    classList: { toggle: () => {} },
    setAttribute: () => {},
    removeAttribute: () => {},
  }));
  runInNewContext(readFileSync('scripts/setup/setup.js', 'utf8'), {
    document: {
      querySelector: (selector: string) => elements.get(selector),
      querySelectorAll: (selector: string) => (selector === '[data-step]' ? steps : progress),
    },
    fetch: async (path: string, options: any) => {
      requests.push({ path, body: JSON.parse(options.body) });
      return { ok: success, json: async () => (success ? { message: 'passed' } : { error: 'connection failed' }) };
    },
    setTimeout,
    location: { replace: () => {} },
  });
  return {
    steps,
    inputs,
    requests,
    elements,
    handlers,
    fail: (value: boolean) => {
      success = !value;
    },
    submit: async () => {
      handlers['form:submit']({ preventDefault() {} });
      await new Promise((done) => setImmediate(done));
    },
    back: () => handlers['previous:click'](),
  };
}

test('wizard tests PostgreSQL before Redis/admin, blocks failed advances and retains values when going back', async () => {
  const ui = browser();
  assert.deepEqual(
    ui.steps.map((step) => step.hidden),
    [false, true, true, true],
  );
  await ui.submit();
  assert.equal(ui.requests.length, 0);
  ui.inputs.get('token').value = 'setup-token';
  await ui.submit();
  assert.equal(ui.requests.at(-1).path, '/setup/verify');
  assert.deepEqual(
    ui.steps.map((step) => step.hidden),
    [true, false, true, true],
  );
  ui.inputs.get('pgHost').value = 'postgres';
  ui.inputs.get('pgPassword').value = 'pg-secret';
  ui.fail(true);
  await ui.submit();
  assert.equal(ui.requests.at(-1).path, '/setup/test-postgres');
  assert.equal(ui.steps[1].hidden, false);
  assert.equal(ui.elements.get('#status').dataset.state, 'error');
  ui.fail(false);
  await ui.submit();
  assert.equal(ui.steps[2].hidden, false);
  assert.equal(ui.inputs.get('adminPassword').value, '');
  ui.inputs.get('redisHost').value = 'redis';
  ui.inputs.get('redisPassword').value = 'redis-secret';
  ui.back();
  assert.equal(ui.steps[1].hidden, false);
  assert.equal(ui.inputs.get('pgPassword').value, 'pg-secret');
  assert.equal(ui.inputs.get('redisPassword').value, 'redis-secret');
  ui.inputs.get('pgHost').value = 'postgres-updated';
  await ui.submit();
  assert.equal(ui.requests.at(-1).body.postgres.host, 'postgres-updated');
  await ui.submit();
  assert.equal(ui.requests.at(-1).path, '/setup/test-redis');
  assert.equal(ui.steps[3].hidden, false);
  ui.inputs.get('adminPassword').value = 'strong-password-123456';
  ui.inputs.get('adminConfirm').value = 'different-password';
  const before = ui.requests.length;
  await ui.submit();
  assert.equal(ui.requests.length, before);
  ui.inputs.get('adminConfirm').value = 'strong-password-123456';
  ui.fail(true);
  await ui.submit();
  assert.equal(ui.requests.at(-1).path, '/setup/install');
  assert.equal(ui.requests.at(-1).body.postgres.host, 'postgres-updated');
  assert.equal(ui.requests.at(-1).body.redis.host, 'redis');
  assert.equal(ui.elements.get('#next').disabled, false, 'Failed install can retry');
});
