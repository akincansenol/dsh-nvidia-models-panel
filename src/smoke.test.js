// Smoke test: load the real host plugin (src/index.js) against a mock Cordis ctx
// and exercise apply() + the route actions + the registered group adapter.
// No network: global.fetch is stubbed where needed.
// Run: ELECTRON_RUN_AS_NODE=1 "<DSH_NODE>" --test src/smoke.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './index.js';

function makeSession() {
  const events = [];
  return { events, append(type, data) { events.push({ type, data }); return { type, data }; } };
}

function makeCtx(opts = {}) {
  const sessions = new Map();
  const sid = 'sess-1';
  sessions.set(sid, makeSession());
  const registered = { commands: [], routes: [], adapters: new Map(), projections: [] };
  const nvidiaModels = opts.nvidiaModels || [
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'L', description: 'd', input: ['text'], contextWindow: 131072, maxTokens: 8192 },
    { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'D', description: 'd2', input: ['text', 'image'] },
  ];
  const llmEntry = {
    id: 'llm-pi-ai',
    options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { nvidia: { apiKeyEnv: 'NVIDIA_API_KEY', models: nvidiaModels } } } },
  };
  const services = {
    commands: { register(desc) { registered.commands.push(desc); return () => {}; } },
    configEditor: {
      entries() { return [llmEntry]; },
      configuration() { return [{ entry: llmEntry, override: llmEntry.options.config }]; },
      async edit(entry, fn) { entry.options.config = fn(entry.options.config, entry.options.config); },
    },
    connection: { fetch: { register(route, label) { registered.routes.push({ route, label }); return () => {}; } } },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) registered.adapters.set(p, adapter);
        return { replace() {} };
      },
      stream(childOptions) {
        // Mock upstream: yield text + stop.
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'ok:' + childOptions.model };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    sessionProjections: { register(def) { registered.projections.push(def); return { dispose() {} }; } },
    credentials: {
      async resolve() { return { value: 'nvapi-test' }; },
      async describe() { return { configured: true, source: 'stored', writable: true }; },
      async set() {}, async unset() {},
    },
    sessions: { get(id) { return sessions.get(id) || null; } },
  };
  const baseCtx = {
    commands: services.commands,
    configEditor: services.configEditor,
    connection: services.connection,
    llm: services.llm,
    inject(deps, fn) {
      // Provide a scoped object exposing the requested services + effect().
      const scoped = { effect() { return () => {}; } };
      let ok = true;
      for (const d of deps) {
        if (services[d]) scoped[d] = services[d];
        else { ok = false; }
      }
      if (!ok) return; // simulate "service not available" (inject simply doesn't fire)
      fn(scoped);
    },
    get(name) { return services[name]; },
  };
  // 严格模拟 Cordis：只有声明在插件 inject 里的服务（commands/configEditor）可以直接 ctx.<name>，
  // 其余服务必须经 ctx.inject(...) 或 ctx.get(...)。未注入直接访问会抛错，
  // 这正是线上 bug「cannot get property "llm" without inject」的成因，用 Proxy 让测试能抓住它。
  const GUARDED = new Set(['llm', 'sessionProjections', 'credentials', 'connection', 'sessions']);
  const ctx = new Proxy(baseCtx, {
    get(target, prop, receiver) {
      if (GUARDED.has(prop)) {
        throw new Error('cannot get property "' + String(prop) + '" without inject');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ctx, registered, services, sessions, sid };
}

test('apply() registers commands, route, adapter, projection without throwing', () => {
  const { ctx, registered } = makeCtx();
  const dispose = plugin.apply(ctx);
  assert.equal(typeof dispose, 'function');
  assert.equal(registered.commands.length, 2);
  assert.ok(registered.commands.some((c) => c.name === 'nvidia-models-detect'));
  assert.equal(registered.routes.length, 1);
  assert.equal(registered.routes[0].route.path, '/api/nvidia-models');
  assert.ok(registered.adapters.has('nvidia-group'), 'group adapter registered');
  assert.equal(registered.projections.length, 1);
  assert.equal(registered.projections[0].key, 'nvidiaHealth');
  assert.equal(registered.projections[0].stateVersion, 1);
  // schema contract
  assert.equal(typeof registered.projections[0].stateSchema.parse, 'function');
  dispose();
});

test('group adapter: providerInfo/listModels/resolveModel/stream work end-to-end', async () => {
  const { ctx, registered, sid } = makeCtx();
  plugin.apply(ctx);
  const adapter = registered.adapters.get('nvidia-group');
  const info = adapter.providerInfo('nvidia-group');
  assert.deepEqual(info, { id: 'nvidia-group', name: 'NVIDIA 模型组' });
  const models = await adapter.listModels('nvidia-group');
  // auto member + 2 real members
  assert.equal(models.length, 3);
  assert.equal(models[0].id, '__auto__');
  assert.equal(models[1].provider, 'nvidia-group');
  const resolved = await adapter.resolveModel('nvidia-group', 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(resolved.id, 'deepseek-ai/deepseek-v4.1-flash');
  const prepared = await adapter.prepareCall('nvidia-group', 'nvidia/nemotron-3.5-lightning-30b-a3b');
  const chunks = [];
  for await (const c of prepared.stream({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', messages: [], sessionId: sid })) chunks.push(c);
  assert.ok(chunks.some((c) => c.type === 'text-delta'));
  assert.equal(chunks[chunks.length - 1].type, 'finish');
  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop');
});

test('route action groupStatus returns members + health', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx);
  const route = registered.routes[0].route;
  const body = JSON.stringify({ action: 'groupStatus' });
  const request = {
    body: { getReader() { let done = false; return { async read() { if (done) return { done: true }; done = true; return { done: false, value: new TextEncoder().encode(body) }; }, async cancel() {} }; } },
  };
  const response = await route.fetch(request);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.group, 'nvidia-group');
  assert.equal(data.members.length, 2);
  assert.ok('cooldownRemainingMs' in data.members[0]);
  assert.ok(data.config.firstByteTimeoutMs >= 1000);
});

test('route action setGroupConfig clamps firstByteTimeoutMs', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx);
  const route = registered.routes[0].route;
  const mk = (obj) => ({ body: { getReader() { let done = false; const b = new TextEncoder().encode(JSON.stringify(obj)); return { async read() { if (done) return { done: true }; done = true; return { done: false, value: b }; }, async cancel() {} }; } } });
  const r1 = await (await route.fetch(mk({ action: 'setGroupConfig', config: { firstByteTimeoutMs: 999999 } }))).json();
  assert.equal(r1.config.firstByteTimeoutMs, 120000); // clamped
  const r2 = await (await route.fetch(mk({ action: 'setGroupConfig', config: { firstByteTimeoutMs: 3000 } }))).json();
  assert.equal(r2.config.firstByteTimeoutMs, 3000);
});

test('route action resetGroup works', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx);
  const route = registered.routes[0].route;
  const body = JSON.stringify({ action: 'resetGroup', model: 'x' });
  const request = { body: { getReader() { let done = false; return { async read() { if (done) return { done: true }; done = true; return { done: false, value: new TextEncoder().encode(body) }; }, async cancel() {} }; } } };
  const data = await (await route.fetch(request)).json();
  assert.equal(data.ok, true);
});

test('disposer is idempotent and resets resolver', () => {
  const { ctx } = makeCtx();
  const dispose = plugin.apply(ctx);
  assert.doesNotThrow(() => dispose());
  assert.doesNotThrow(() => dispose());
});
