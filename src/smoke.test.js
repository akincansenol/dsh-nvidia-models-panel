// Smoke test: load the real host plugin (src/index.js) against a mock Cordis ctx
// and exercise apply() + the route actions + the registered group adapter.
// No network: global.fetch is stubbed where needed.
// Run: ELECTRON_RUN_AS_NODE=1 "<DSH_NODE>" --test src/smoke.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './index.js';

function makeSession(provider) {
  const events = [];
  const session = { events, append(type, data) { events.push({ type, data }); return { type, data }; } };
  if (provider) session.requestHeader = function () { return { config: { provider: provider, model: 'x', maxTokens: 8192 } }; };
  return session;
}

function makeCtx(opts = {}) {
  const sessions = new Map();
  const sid = 'sess-1';
  sessions.set(sid, makeSession(opts.currentProvider));
  const registered = { commands: [], routes: [], adapters: new Map(), projections: [] };
  const nvidiaModels = opts.nvidiaModels || [
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'L', description: 'd', input: ['text'], contextWindow: 131072, maxTokens: 8192 },
    { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'D', description: 'd2', input: ['text', 'image'] },
  ];
  const llmEntry = {
    id: 'llm-pi-ai',
    options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'one-balance-nvidia': { apiKeyEnv: 'ONE_BALANCE_API_KEY', models: nvidiaModels } } } },
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
      async describe() { return opts.keyConfigured === false
        ? { configured: false, source: null, writable: true }
        : { configured: true, source: 'stored', writable: true }; },
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

test('route action dockStatus reflects the model that actually produced text + failover count', async () => {
  const { ctx, registered, sid } = makeCtx();
  plugin.apply(ctx);
  const route = registered.routes[0].route;
  const adapter = registered.adapters.get('nvidia-group');
  const mk = (obj) => ({ body: { getReader() { let done = false; const b = new TextEncoder().encode(JSON.stringify(obj)); return { async read() { if (done) return { done: true }; done = true; return { done: false, value: b }; }, async cancel() {} }; } } });

  // Before any use, the badge is inactive (module state reset on apply()).
  const before = await (await route.fetch(mk({ action: 'dockStatus' }))).json();
  assert.equal(before.ok, true);
  assert.equal(before.active, false);

  // A successful stream that emits visible text should mark the member as active.
  const prepared = await adapter.prepareCall('nvidia-group', 'nvidia/nemotron-3.5-lightning-30b-a3b');
  for await (const _ of prepared.stream({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', messages: [], sessionId: sid })) { /* drain */ }
  const after = await (await route.fetch(mk({ action: 'dockStatus' }))).json();
  assert.equal(after.active, true);
  assert.equal(after.memberId, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.ok(after.memberName && after.memberName.length > 0);
  assert.equal(typeof after.switchCount, 'number');
  assert.equal(typeof after.cooldownCount, 'number');

  // 当前会话仍使用 nvidia-group：徽标保持可见。
  const withGroup = await (await route.fetch(mk({ action: 'dockStatus', sessionId: sid }))).json();
  assert.equal(withGroup.active, true, 'stays visible while session uses nvidia-group');
});

test('dock badge hides once the session switches to a non-nvidia-group model', async () => {
  const { ctx, registered, sid, services } = makeCtx();
  plugin.apply(ctx);
  const route = registered.routes[0].route;
  const adapter = registered.adapters.get('nvidia-group');
  const mk = (obj) => ({ body: { getReader() { let done = false; const b = new TextEncoder().encode(JSON.stringify(obj)); return { async read() { if (done) return { done: true }; done = true; return { done: false, value: b }; }, async cancel() {} }; } } });

  // Produce text with the group so dockGroupState becomes active.
  const prepared = await adapter.prepareCall('nvidia-group', 'nvidia/nemotron-3.5-lightning-30b-a3b');
  for await (const _ of prepared.stream({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', messages: [], sessionId: sid })) { /* drain */ }
  const active = await (await route.fetch(mk({ action: 'dockStatus', sessionId: sid }))).json();
  assert.equal(active.active, true, 'active with no header info (best-effort)');

  // Now the session's latest header says a different provider -> badge hides.
  services.sessions.get(sid).requestHeader = function () {
    return { config: { provider: 'workbuddy-models', model: 'deepseek-v4.1-flash', maxTokens: 8192 } };
  };
  const hidden = await (await route.fetch(mk({ action: 'dockStatus', sessionId: sid }))).json();
  assert.equal(hidden.active, false, 'hidden after switching away from nvidia-group');
  // The underlying state is intact, so switching back re-shows it.
  services.sessions.get(sid).requestHeader = function () {
    return { config: { provider: 'nvidia-group', model: '__auto__', maxTokens: 8192 } };
  };
  const reshown = await (await route.fetch(mk({ action: 'dockStatus', sessionId: sid }))).json();
  assert.equal(reshown.active, true, 're-shown after switching back');
});

test('dock badge hides when a specific group member is selected instead of auto', async () => {
  const { ctx, registered, sid, services } = makeCtx();
  plugin.apply(ctx);
  const route = registered.routes[0].route;
  const adapter = registered.adapters.get('nvidia-group');
  const mk = (obj) => ({ body: { getReader() { let done = false; const b = new TextEncoder().encode(JSON.stringify(obj)); return { async read() { if (done) return { done: true }; done = true; return { done: false, value: b }; }, async cancel() {} }; } } });

  // Produce text with the group so dockGroupState becomes active.
  const prepared = await adapter.prepareCall('nvidia-group', 'nvidia/nemotron-3.5-lightning-30b-a3b');
  for await (const _ of prepared.stream({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', messages: [], sessionId: sid })) { /* drain */ }
  const active = await (await route.fetch(mk({ action: 'dockStatus', sessionId: sid }))).json();
  assert.equal(active.active, true, 'active with no header info (best-effort)');

  // Auto mode -> visible.
  services.sessions.get(sid).requestHeader = function () {
    return { config: { provider: 'nvidia-group', model: '__auto__', maxTokens: 8192 } };
  };
  const autoShown = await (await route.fetch(mk({ action: 'dockStatus', sessionId: sid }))).json();
  assert.equal(autoShown.active, true, 'visible in auto mode');

  // A specific member of the group selected -> badge hides.
  services.sessions.get(sid).requestHeader = function () {
    return { config: { provider: 'nvidia-group', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', maxTokens: 8192 } };
  };
  const specificHidden = await (await route.fetch(mk({ action: 'dockStatus', sessionId: sid }))).json();
  assert.equal(specificHidden.active, false, 'hidden when a specific group member is picked');
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

test('route actions that need a key early-return NO_API_KEY when no key configured', async () => {
  const mk = (obj) => ({ body: { getReader() { let done = false; const b = new TextEncoder().encode(JSON.stringify(obj)); return { async read() { if (done) return { done: true }; done = true; return { done: false, value: b }; }, async cancel() {} }; } } });
  const mc = makeCtx({ keyConfigured: false });
  plugin.apply(mc.ctx);
  const route = mc.registered.routes[0].route;

  // 需要 Key 的 action 全部早退，并给出一致的 NO_API_KEY 提示。
  for (const action of ['test', 'configure', 'probeGroup', 'groupStatus', 'dockStatus', 'usageStats']) {
    const data = await (await route.fetch(mk({ action }))).json();
    assert.equal(data.code, 'NO_API_KEY', action + ' should be blocked');
    assert.equal(data.ok, false);
    assert.match(data.message, /API Key/);
  }

  // 不依赖 Key 的 action 仍然可用。
  const keyStatus = await (await route.fetch(mk({ action: 'keyStatus' }))).json();
  assert.equal(keyStatus.configured, false);
  const update = await (await route.fetch(mk({ action: 'checkUpdate' }))).json();
  assert.ok(update && typeof update === 'object');
  mc.services.llm.stream = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })();
});

test('adapter turns a missing-credential upstream failure into a fatal NO_API_KEY finish (no failover)', async () => {
  const mc = makeCtx();
  let streamCalls = 0;
  mc.services.llm.stream = () => { streamCalls += 1; return (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: 'missing credential' } } };
  })(); };
  plugin.apply(mc.ctx);
  const adapter = mc.registered.adapters.get('nvidia-group');
  const prepared = await adapter.prepareCall('nvidia-group', '__auto__');
  const chunks = [];
  for await (const c of prepared.stream({ model: '__auto__', messages: [], sessionId: mc.sid })) chunks.push(c);
  const finish = chunks[chunks.length - 1];
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'NO_API_KEY');
  assert.match(finish.reason.failure.message, /API Key/);
  // 致命错误不应逐个成员重试：只尝试了 1 次。
  assert.equal(streamCalls, 1, 'fatal key error must not fail over across members');
});

test('disposer is idempotent and resets resolver', () => {
  const { ctx } = makeCtx();
  const dispose = plugin.apply(ctx);
  assert.doesNotThrow(() => dispose());
  assert.doesNotThrow(() => dispose());
});

test('apply() clears stale health so previously-cooled members are retried', async () => {
  const mk = (obj) => ({ body: { getReader() { let done = false; const b = new TextEncoder().encode(JSON.stringify(obj)); return { async read() { if (done) return { done: true }; done = true; return { done: false, value: b }; }, async cancel() {} }; } } });
  const mc = makeCtx();
  // 上游全失败：让成员累计失败、进入熔断。
  mc.services.llm.stream = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'boom' } } };
  })();
  plugin.apply(mc.ctx);
  const route = mc.registered.routes[0].route;
  const adapter = mc.registered.adapters.get('nvidia-group');
  for (let i = 0; i < 2; i += 1) {
    const prepared = await adapter.prepareCall('nvidia-group', 'nvidia/nemotron-3.5-lightning-30b-a3b');
    // eslint-disable-next-line no-unused-vars
    for await (const _ of prepared.stream({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', messages: [], sessionId: mc.sid })) { /* drain */ }
  }
  const before = await (await route.fetch(mk({ action: 'groupStatus' }))).json();
  const mBefore = before.members.find((m) => m.id === 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.ok(mBefore.failCount >= 2, 'seat should have accumulated failures');
  assert.ok(mBefore.cooldownRemainingMs > 0, 'seat should be cooling down before reload');

  // 重载（再次 apply）应清空这份进程级旧健康状态。
  plugin.apply(mc.ctx);
  const after = await (await route.fetch(mk({ action: 'groupStatus' }))).json();
  const mAfter = after.members.find((m) => m.id === 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(mAfter.failCount, 0);
  assert.equal(mAfter.cooldownRemainingMs, 0);
});
