// Unit tests for the pure failover engine (no DSH, no deps).
// Run: ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" --test src/group.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isErrorFinish, isContentChunk, createHealthRegistry, rankMembers,
  runFailover, createGroupAdapter, createGroupState, parseGroupState,
  makeSchema, foldGroupEvent, describeError, requestHasImage, memberSupportsImage,
  isCapabilityMismatch,
  AUTO_MEMBER_ID, AUTO_MEMBER_NAME, isAutoMemberId,
} from './group.js';

const chunkText = (t) => ({ type: 'text-delta', index: 0, text: t });
const chunkFinishStop = { type: 'finish', reason: { kind: 'stop' } };
const chunkFinishErr = (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } });

async function collect(iter) {
  const out = [];
  for await (const c of iter) out.push(c);
  return out;
}

test('isErrorFinish / isContentChunk', () => {
  assert.equal(isErrorFinish(chunkFinishErr('X', 'y')), true);
  assert.equal(isErrorFinish(chunkFinishStop), false);
  assert.equal(isErrorFinish({ type: 'finish', reason: { kind: 'aborted', failure: {} } }), true);
  assert.equal(isContentChunk(chunkText('hi')), true);
  assert.equal(isContentChunk(chunkText('')), false);
  assert.equal(isContentChunk({ type: 'text-delta', index: 0, text: '' }), false);
});

test('health registry: cooldown after threshold with backoff', () => {
  let t = 1000;
  const h = createHealthRegistry({ failThreshold: 2, baseCooldownMs: 20000, maxCooldownMs: 300000, now: () => t });
  h.recordFailure('a', { message: 'x' });
  assert.equal(h.isCoolingDown('a'), false); // 1 fail < threshold
  h.recordFailure('a', { message: 'x' });
  assert.equal(h.isCoolingDown('a'), true);
  assert.equal(h.cooldownRemainingMs('a'), 20000);
  t += 20000;
  assert.equal(h.isCoolingDown('a'), false);
  // 3rd failure -> 40s
  t += 1000;
  h.recordFailure('a', { message: 'x' });
  assert.equal(h.cooldownRemainingMs('a'), 40000);
  h.recordSuccess('a', 123);
  assert.equal(h.get('a').failCount, 0);
  assert.equal(h.get('a').cooldownUntil, 0);
  assert.equal(h.get('a').lastFirstByteMs, 123);
});

test('rankMembers: preferred first, cooling last, fewer fails earlier', () => {
  const now = () => 1000;
  const h = createHealthRegistry({ failThreshold: 2, baseCooldownMs: 20000, now });
  h.recordFailure('c', {}); h.recordFailure('c', {}); // c cooling
  h.recordFailure('b', {}); // b 1 fail
  const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const order = rankMembers(members, h, 'b', now).map((m) => m.id);
  assert.deepEqual(order, ['b', 'a', 'c']);
});

test('runFailover: first member fails -> falls over to second, no content leaked', async () => {
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    if (opts.model === 'm1') {
      yield chunkFinishErr('UPSTREAM', 'boom');
      return;
    }
    yield chunkText('hello');
    yield chunkFinishStop;
  })();
  const health = createHealthRegistry({ failThreshold: 2 });
  const deps = {
    streamChild, health, candidates: [{ id: 'm1' }, { id: 'm2' }],
    onFailover: () => { deps.failedOver = (deps.failedOver || 0) + 1; },
  };
  const out = await collect(runFailover({ provider: 'nvidia-group', model: 'm1', messages: [] }, deps));
  assert.deepEqual(calls, ['m1', 'm2']);
  assert.equal(out.filter((c) => c.type === 'text-delta').length, 1);
  assert.ok(isErrorFinish(out[out.length - 1]) === false && out[out.length - 1].type === 'finish');
  assert.equal(out[out.length - 1].reason.kind, 'stop');
  assert.equal(deps.failedOver, 1);
});

test('runFailover: all members fail -> synthesized ALL_MEMBERS_FAILED', async () => {
  const streamChild = () => (async function* () { yield chunkFinishErr('UPSTREAM', 'boom'); })();
  const deps = { streamChild, health: createHealthRegistry(), candidates: [{ id: 'a' }, { id: 'b' }] };
  const out = await collect(runFailover({ model: 'a', messages: [] }, deps));
  const last = out[out.length - 1];
  assert.equal(last.reason.kind, 'error');
  assert.equal(last.reason.failure.code, 'UPSTREAM');
});

test('runFailover: skips cooling members -> ALL_MEMBERS_COOLING when none left', async () => {
  let t = 1000;
  const health = createHealthRegistry({ failThreshold: 1, baseCooldownMs: 20000, now: () => t });
  health.recordFailure('a', {}); health.recordFailure('b', {});
  const streamChild = () => (async function* () { yield chunkFinishStop; })();
  const out = await collect(runFailover({ model: 'a', messages: [] }, { streamChild, health, candidates: [{ id: 'a' }, { id: 'b' }] }));
  assert.equal(out[out.length - 1].reason.failure.code, 'ALL_MEMBERS_COOLING');
});

test('runFailover: content already emitted -> no silent switch, surfaces error', async () => {
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    yield chunkText('partial');
    yield chunkFinishErr('MIDSTREAM', 'died mid-stream');
  })();
  const out = await collect(runFailover({ model: 'a', messages: [] }, { streamChild, health: createHealthRegistry(), candidates: [{ id: 'a' }, { id: 'b' }] }));
  assert.deepEqual(calls, ['a']); // did NOT try b
  assert.equal(out[out.length - 1].reason.kind, 'error');
});

test('runFailover: first-byte watchdog aborts stalled member and fails over', async () => {
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    if (opts.model === 'stall') {
      // never yields; wait until signal aborts
      await new Promise((resolve) => {
        if (opts.signal.aborted) return resolve();
        opts.signal.addEventListener('abort', resolve, { once: true });
      });
      const err = new Error('aborted'); err.name = 'AbortError';
      throw err;
    }
    yield chunkText('fast');
    yield chunkFinishStop;
  })();
  const started = Date.now();
  const out = await collect(runFailover(
    { model: 'stall', messages: [] },
    { streamChild, health: createHealthRegistry(), candidates: [{ id: 'stall' }, { id: 'fast' }], firstByteTimeoutMs: 200 },
  ));
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(calls, ['stall', 'fast']);
  assert.equal(out[out.length - 1].reason.kind, 'stop');
});

test('runFailover: firstByteTimeoutMs may be a function and is read per request', async () => {
  let current = 5000;
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    yield chunkText('ok:' + opts.model);
    yield chunkFinishStop;
  })();
  const out = await collect(runFailover(
    { model: 'a', messages: [] },
    { streamChild, health: createHealthRegistry(), candidates: [{ id: 'a' }], firstByteTimeoutMs: () => current },
  ));
  assert.equal(out[out.length - 1].reason.kind, 'stop');
  assert.deepEqual(calls, ['a']);
});

test('createGroupAdapter: listModels/resolveModel/prepareCall/stream shapes', async () => {
  const members = [
    { id: 'm1', name: 'M1', description: 'd1', inputModalities: ['text'] },
    { id: 'm2', name: 'M2', description: 'd2', inputModalities: ['text', 'image'] },
  ];
  const adapter = createGroupAdapter({
    getMembers: async () => members,
    streamChild: (opts) => (async function* () { yield chunkText('x:' + opts.model); yield chunkFinishStop; })(),
    health: createHealthRegistry(),
  });
  assert.deepEqual(adapter.providerInfo('nvidia-group'), { id: 'nvidia-group', name: 'NVIDIA 模型组' });
  const list = await adapter.listModels('nvidia-group');
  // First entry is the virtual "auto" member, then the real group members.
  assert.equal(list[0].id, AUTO_MEMBER_ID);
  assert.equal(list[1].provider, 'nvidia-group');
  assert.equal(list[1].id, 'm1');
  assert.equal(list[2].inputModalities.includes('image'), true);
  // resolveModel on the auto id returns a synthetic info (no member lookup).
  const autoResolved = await adapter.resolveModel('nvidia-group', AUTO_MEMBER_ID);
  assert.equal(autoResolved.id, AUTO_MEMBER_ID);
  assert.equal(autoResolved.name, AUTO_MEMBER_NAME);
  assert.ok(autoResolved.context.contextWindow > 0);
  const resolved = await adapter.resolveModel('nvidia-group', 'm2');
  assert.equal(resolved.provider, 'nvidia-group');
  assert.equal(resolved.id, 'm2');
  assert.equal(resolved.name, 'M2');
  assert.deepEqual(resolved.inputModalities, ['text', 'image']);
  const prepared = await adapter.prepareCall('nvidia-group', 'm1');
  const out = await collect(prepared.stream({ model: 'm1', messages: [] }));
  assert.equal(out[0].text, 'x:m1');
});

test('projection: foldGroupEvent over failover + probe', () => {
  let s = createGroupState();
  s = foldGroupEvent(s, { type: 'nvidia-group/failover', time: 100, data: { from: 'm1', error: 'boom' } });
  assert.equal(s.members.m1.status, 'failed');
  assert.equal(s.members.m1.failCount, 1);
  s = foldGroupEvent(s, { type: 'nvidia-group/failover', time: 200, data: { from: 'm2', to: 'm3' } });
  assert.equal(s.members.m3.status, 'ok');
  assert.equal(s.timeline.length, 2);
  s = foldGroupEvent(s, { type: 'nvidia-group/probe', time: 300, data: { member: 'm1', status: 'ok' } });
  assert.equal(s.members.m1.status, 'ok');
  assert.equal(s.members.m1.lastError, '');
});

test('schema contract: makeSchema().parse round-trips and rejects garbage', () => {
  const schema = makeSchema();
  const good = schema.parse({ members: { a: { status: 'ok', failCount: 0 } }, timeline: [] });
  assert.equal(good.members.a.status, 'ok');
  assert.deepEqual(schema.parse(null), createGroupState());
  assert.deepEqual(schema.parse('junk'), createGroupState());
});

test('describeError handles strings, objects, null', () => {
  assert.equal(describeError(null), 'unknown error');
  assert.equal(describeError('boom'), 'boom');
  assert.equal(describeError({ message: 'm' }), 'm');
  assert.equal(describeError({ code: 'C' }), 'C');
});

test('capability-aware routing: image request only uses vision-capable members', async () => {
  const calls = [];
  const members = [
    { id: 'text-only-model', name: 'T', inputModalities: ['text'] },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Omni', inputModalities: ['text', 'image'] },
  ];
  const adapter = createGroupAdapter({
    getMembers: async () => members,
    streamChild: (opts) => (async function* () { calls.push(opts.model); yield chunkText('ok'); yield chunkFinishStop; })(),
    health: createHealthRegistry(),
  });
  // Pick the text-only member, but send an image → must skip to the omni member.
  const imgOptions = {
    model: 'text-only-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: {} }] }],
  };
  const out = [];
  for await (const c of adapter.stream(imgOptions)) out.push(c);
  assert.equal(out[out.length - 1].reason.kind, 'stop');
  assert.deepEqual(calls, ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning']);
});

test('requestHasImage / memberSupportsImage helpers', () => {
  assert.equal(requestHasImage({ messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(requestHasImage({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), true);
  assert.equal(requestHasImage({ messages: [] }), false);
  assert.equal(memberSupportsImage({ id: 'x', inputModalities: ['text', 'image'] }), true);
  assert.equal(memberSupportsImage({ id: 'x', inputModalities: ['text'] }), false);
  assert.equal(memberSupportsImage({ id: 'some-vl-model' }), true);
});

test('auto member: pure-health ordering, never child-streams the auto id', async () => {
  const members = [
    { id: 'slow', name: 'Slow', inputModalities: ['text'] },
    { id: 'fast', name: 'Fast', inputModalities: ['text'] },
  ];
  const health = createHealthRegistry();
  // Make 'slow' look slower so health ranking prefers 'fast'.
  health.recordSuccess('slow', 900);
  health.recordSuccess('fast', 120);
  const calls = [];
  const adapter = createGroupAdapter({
    getMembers: async () => members,
    streamChild: (opts) => (async function* () { calls.push(opts.model); yield chunkText('ok:' + opts.model); yield chunkFinishStop; })(),
    health,
  });
  // listModels exposes the auto member first.
  const list = await adapter.listModels('nvidia-group');
  assert.equal(list[0].id, AUTO_MEMBER_ID);
  assert.equal(isAutoMemberId(AUTO_MEMBER_ID), true);
  assert.equal(isAutoMemberId('nvidia/foo'), false);
  // Selecting the auto member must NOT pass '__auto__' downstream; it picks the
  // healthiest real member ('fast').
  const out = await collect(adapter.stream({ model: AUTO_MEMBER_ID, messages: [] }));
  assert.equal(out[out.length - 1].reason.kind, 'stop');
  assert.deepEqual(calls, ['fast']);
  // Picking a specific member still tries it first.
  calls.length = 0;
  await collect(adapter.stream({ model: 'slow', messages: [] }));
  assert.deepEqual(calls, ['slow']);
});

test('isCapabilityMismatch: only context/compaction codes count', () => {
  assert.equal(isCapabilityMismatch({ code: 'CONTEXT_WINDOW_EXCEEDED' }), true);
  assert.equal(isCapabilityMismatch({ code: 'MODEL_SWITCH_COMPACTION_FAILED' }), true);
  assert.equal(isCapabilityMismatch({ code: 'UPSTREAM' }), false);
  assert.equal(isCapabilityMismatch(null), false);
  assert.equal(isCapabilityMismatch('x'), false);
});

test('runFailover: context overflow on a member is a capability mismatch -> skip to next, NO circuit penalty', async () => {
  const health = createHealthRegistry({ failThreshold: 2 });
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    if (opts.model === 'a') { yield chunkFinishErr('CONTEXT_WINDOW_EXCEEDED', 'overflow'); return; }
    yield chunkText('hello');
    yield chunkFinishStop;
  })();
  const fired = [];
  const deps = {
    streamChild, health, candidates: [{ id: 'a', contextWindow: 131072 }, { id: 'b', contextWindow: 1048576 }],
    onAttempt: (info) => fired.push(info),
  };
  const out = await collect(runFailover({ model: 'a', messages: [] }, deps));
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(out.some((c) => c.type === 'text-delta'), true);
  assert.equal(out[out.length - 1].reason.kind, 'stop');
  // 'a' failed only because it's too small — must NOT be recorded as a failure/circuit
  assert.equal(health.get('a').failCount, 0);
  assert.equal(health.isCoolingDown('a'), false);
  const aAttempt = fired.find((f) => f.member.id === 'a');
  assert.equal(aAttempt.capability, true);
});

test('runFailover: all members overflow -> surfaces the overflow error (honest failure)', async () => {
  const streamChild = () => (async function* () { yield chunkFinishErr('CONTEXT_WINDOW_EXCEEDED', 'too big'); })();
  const deps = { streamChild, health: createHealthRegistry(), candidates: [{ id: 'a' }, { id: 'b' }] };
  const out = await collect(runFailover({ model: 'a', messages: [] }, deps));
  const last = out[out.length - 1];
  assert.equal(last.reason.kind, 'error');
  assert.equal(last.reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED');
});

test('auto member resolveModel uses members\u2019 max context window, not a hardcoded 128K', async () => {
  const adapter = createGroupAdapter({
    getMembers: async () => [
      { id: 'small', name: 'S', contextWindow: 131072 },
      { id: 'big', name: 'B', contextWindow: 1048576 },
    ],
    streamChild: () => (async function* () { yield chunkFinishStop; })(),
    health: createHealthRegistry(),
  });
  const info = await adapter.resolveModel('nvidia-group', AUTO_MEMBER_ID);
  assert.equal(info.context.contextWindow, 1048576);
});

// ───────────── 重推理模型烧光输出预算（零正文）→ 无痕切换 ─────────────

test('isVisibleOutputChunk: reasoning-delta 不算可见正文，text/tool 才算', async () => {
  const { isVisibleOutputChunk, isReasoningModel } = await import('./group.js');
  assert.equal(isVisibleOutputChunk({ type: 'reasoning-delta', index: 0, text: '思考' }), false);
  assert.equal(isVisibleOutputChunk({ type: 'text-delta', index: 0, text: 'hi' }), true);
  assert.equal(isVisibleOutputChunk({ type: 'text-delta', index: 0, text: '' }), false);
  assert.equal(isVisibleOutputChunk({ type: 'tool-call-delta', index: 0, argumentsDelta: '{' }), true);
  assert.equal(isReasoningModel('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'), true);
  assert.equal(isReasoningModel('nvidia/nemotron-3.5-lightning-30b-a3b'), false);
});

test('runFailover: 成员只有思考无正文 → 丢弃缓存、静默切下一个、不熔断', async () => {
  const health = createHealthRegistry();
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    if (opts.model === 'reasoner') {
      // 首字节很快，然后大量 reasoning，最后撞 max-tokens，正文为空
      yield { type: 'reasoning-delta', index: 0, text: '嗯……' };
      yield { type: 'reasoning-delta', index: 0, text: '继续想……' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
      return;
    }
    yield chunkText('真正回答');
    yield chunkFinishStop;
  })();
  const deps = { streamChild, health, candidates: [{ id: 'reasoner' }, { id: 'plain' }] };
  const out = await collect(runFailover({ model: 'reasoner', messages: [] }, { ...deps }));
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  // 用户只看到普通模型的正文，reasoner 的思考一个字都没泄漏
  assert.equal(text, '真正回答');
  assert.equal(out.some((c) => c.type === 'reasoning-delta'), false);
  assert.equal(out[out.length - 1].reason.kind, 'stop');
  // 空正文属于“这次请求不称职”，不应把 reasoner 记为故障
  assert.equal(health.get('reasoner').failCount, 0);
});

test('runFailover: 无备份成员时，即便只有思考也如实交出（不静默吞掉）', async () => {
  const health = createHealthRegistry();
  const streamChild = () => (async function* () {
    yield { type: 'reasoning-delta', index: 0, text: '思考' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  })();
  const out = await collect(runFailover({ model: 'only', messages: [] }, { streamChild, health, candidates: [{ id: 'only' }] }));
  // 只有一个成员、没有备份：把缓存的思考与 finish 原样交出，用户能看到真实情况
  assert.equal(out.some((c) => c.type === 'reasoning-delta'), true);
  assert.equal(out[out.length - 1].type, 'finish');
});

test('runFailover: 首段正文看门狗——正文迟迟不来则中止切换', async () => {
  const health = createHealthRegistry();
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    if (opts.model === 'slow') {
      // 一直只发思考，永远不给正文；靠看门狗 abort（必须尊重 signal，否则永不结束）
      while (!(opts.signal && opts.signal.aborted)) {
        await new Promise((r) => setTimeout(r, 10));
        if (opts.signal && opts.signal.aborted) break;
        yield { type: 'reasoning-delta', index: 0, text: '.' };
      }
      throw new Error('aborted');
    }
    yield chunkText('ok');
    yield chunkFinishStop;
  })();
  const deps = { streamChild, health, candidates: [{ id: 'slow' }, { id: 'fast' }], firstTextTimeoutMs: () => 60 };
  const out = await collect(runFailover({ model: 'slow', messages: [] }, deps));
  assert.deepEqual(calls, ['slow', 'fast']);
  assert.equal(out.filter((c) => c.type === 'text-delta').pop().text, 'ok');
  assert.equal(out[out.length - 1].reason.kind, 'stop');
});

test('rankMembers: 自动模式下思考型模型排到普通模型之后', () => {
  const members = [
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' },
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
    { id: 'z-ai/glm-5.3-flash' },
  ];
  const order = rankMembers(members, createHealthRegistry(), '', () => 1000).map((m) => m.id);
  assert.equal(order[order.length - 1], 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
});

test('runFailover: 自动模式下不把 __auto__ 当首选，思考型模型仍排到后面', async () => {
  const calls = [];
  const streamChild = (opts) => (async function* () {
    calls.push(opts.model);
    yield chunkText('ok'); yield chunkFinishStop;
  })();
  const members = [
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' },
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
  ];
  const out = await collect(runFailover({ model: AUTO_MEMBER_ID, messages: [] }, { streamChild, health: createHealthRegistry(), candidates: members }));
  assert.deepEqual(calls, ['nvidia/nemotron-3.5-lightning-30b-a3b']); // 普通模型先被调用
  assert.equal(out[out.length - 1].reason.kind, 'stop');
});
