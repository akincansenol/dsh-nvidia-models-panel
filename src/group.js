/**
 * NVIDIA 模型组：自愈式故障转移引擎（纯逻辑，无 DSH / 无外部依赖）。
 *
 * 设计要点
 *  - 组内成员按健康度排序：首选模型优先 → 未冷却优先 → 失败次数少优先 → 首包快优先 → 配置顺序。
 *  - 熔断：连续失败达到阈值即进入冷却（指数退避，封顶），冷却期内直接跳过。
 *  - 流式转移只在“尚未产出任何内容”时发生；一旦已向用户吐出文本/推理/工具增量，
 *    就不再做无痕切换（避免内容重复），而是如实返回错误。
 *  - 全部成员失败时产出合成错误 finish，交给上层（dsh-llm-retry / 会话投影）处理。
 *
 * 所有对外函数只依赖注入进来的 deps，便于脱离 DSH 用 node --test 单测。
 */

/** 虚拟「自动」成员的模型 id：不指定首选，纯按实时健康排序。 */
export const AUTO_MEMBER_ID = '__auto__';
/** 「自动」成员的展示名 / 描述。 */
export const AUTO_MEMBER_NAME = 'NVIDIA Group (Auto)';
export const AUTO_MEMBER_DESC = 'Auto-select healthiest model and fail over automatically';

/** 判断一个模型 id 是否为「自动」虚拟成员。 */
export function isAutoMemberId(id) {
  return id === AUTO_MEMBER_ID || id === 'auto';
}

/**
 * 该失败是否只是「这个成员吃不消这轮请求」（例如上下文窗口不够），
 * 而非「该模型不可用」。这类失败应当直接换下一个成员，
 * 且不计入熔断（模型本身是好的，只是不适合这次请求）。
 */
/**
 * 致命失败：对所有组员都一样，换模型也不会好转，因此应立即停止故障转移。
 * 目前仅「缺 API Key / 凭据失效」属于此类。
 */
export function isFatalFailure(failure) {
  return Boolean(failure && typeof failure === 'object' && failure.code === 'NO_API_KEY');
}

export function isCapabilityMismatch(failure) {
  if (!failure || typeof failure !== 'object') return false;
  if (failure.code === 'CONTEXT_WINDOW_EXCEEDED' || failure.code === 'MODEL_SWITCH_COMPACTION_FAILED' || failure.code === 'INVALID_REQUEST') {
    return true; // 400 类「这次请求该模型吃不下」——换下一个即可，不熔断
  }
  // 上游把「多模态未启用 / 不支持图片」报成 400，也归到这一类。
  const msg = String(failure.message || '');
  return /multimodal|not enabled|invalid.?request|does not support image/i.test(msg);
}

/** 判定一个流块是否为错误/取消的 finish。 */
export function isErrorFinish(chunk) {
  return Boolean(
    chunk && chunk.type === 'finish' && chunk.reason &&
    (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'),
  );
}

/** 判定一个流块是否携带“用户可见内容”（用于决定能否无痕转移）。 */
export function isContentChunk(chunk) {
  return Boolean(
    chunk && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') &&
    chunk.text !== '' && chunk.argumentsDelta !== '',
  );
}

/**
 * 判定一个流块是否为“真正的回答产出”（用户可见的正文或工具调用）。
 * 注意：reasoning-delta（思考过程）**不算**——模型可能把整个输出预算烧在思考上、
 * 一个字的回答都没给出，这种情况必须能和“已给出部分回答”区分开。
 */
export function isVisibleOutputChunk(chunk) {
  if (!chunk) return false;
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text !== '';
  if (chunk.type === 'tool-call-delta') {
    return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') || Boolean(chunk.name);
  }
  return false;
}

/**
 * 是否属于“重推理 / 思考型”模型。这类模型面对复杂任务时可能长时间只输出思考内容，
 * 在“自动”模式下应排到普通模型之后，避免整轮对话被它的思考拖死。
 */
export function isReasoningModel(id) {
  return /reasoning|thinking|omni|debate/i.test(String(id || ''));
}

/**
 * 健康登记表 + 熔断器。默认：连续 2 次失败即冷却 20s，按 2^k 退避，封顶 5 分钟。
 * @param {{baseCooldownMs?:number,maxCooldownMs?:number,failThreshold?:number,now?:()=>number}} [opts]
 */
export function createHealthRegistry(opts) {
  const o = opts || {};
  const baseCooldownMs = Number.isFinite(o.baseCooldownMs) ? o.baseCooldownMs : 20000;
  const maxCooldownMs = Number.isFinite(o.maxCooldownMs) ? o.maxCooldownMs : 300000;
  const failThreshold = Number.isFinite(o.failThreshold) ? o.failThreshold : 2;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const map = new Map();

  function entry(id) {
    let e = map.get(id);
    if (!e) {
      e = {
        id,
        ok: null,
        failCount: 0,
        successCount: 0,
        lastError: '',
        cooldownUntil: 0,
        lastFirstByteMs: null,
        lastProbeAt: null,
        lastChangeAt: now(),
      };
      map.set(id, e);
    }
    return e;
  }

  return {
    /** 只读快照（拷贝），用于渲染看板。 */
    get(id) { return { ...entry(id) }; },
    snapshot(ids) {
      const keys = Array.isArray(ids) ? ids : [...map.keys()];
      const out = {};
      for (const id of keys) out[id] = this.get(id);
      return out;
    },
    isCoolingDown(id) { return entry(id).cooldownUntil > now(); },
    cooldownRemainingMs(id) { return Math.max(0, entry(id).cooldownUntil - now()); },
    recordProbeStart(id) { const e = entry(id); e.lastProbeAt = now(); return { ...e }; },
    recordSuccess(id, firstByteMs) {
      const e = entry(id);
      e.ok = true;
      e.failCount = 0;
      e.successCount += 1;
      e.lastError = '';
      e.cooldownUntil = 0;
      if (typeof firstByteMs === 'number' && firstByteMs >= 0) e.lastFirstByteMs = Math.round(firstByteMs);
      e.lastChangeAt = now();
      return { ...e };
    },
    recordFailure(id, error) {
      const e = entry(id);
      e.ok = false;
      e.failCount += 1;
      e.lastError = describeError(error).slice(0, 240);
      e.lastChangeAt = now();
      if (e.failCount >= failThreshold) {
        const k = e.failCount - failThreshold;
        const backoff = Math.min(maxCooldownMs, baseCooldownMs * Math.pow(2, k));
        e.cooldownUntil = now() + backoff;
      }
      return { ...e };
    },
    reset(id) {
      if (id === undefined) map.clear();
      else map.delete(id);
    },
  };
}

/** 把任意错误对象压成一句人类可读文本。 */
export function describeError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  if (error.code) return String(error.code);
  try { return JSON.stringify(error); } catch { return String(error); }
}

/**
 * 组内成员排序：preferredId 优先；其次未冷却；再次失败少、首包快、配置顺序。
 * 当没有指定首选（“自动”模式）时，思考型/重推理模型整体排在普通模型之后 —— 它们
 * 更容易把输出预算耗在思考上、迟迟不给正文，不适合作为默认首选。
 * @param {Array<{id:string}>} members
 * @param {any} health createHealthRegistry() 的实例（可空）
 * @param {string} [preferredId]
 * @param {()=>number} [clock]
 */
export function rankMembers(members, health, preferredId, clock) {
  const nowFn = typeof clock === 'function' ? clock : () => Date.now();
  const list = Array.isArray(members) ? members : [];
  const scored = list.map((m, index) => {
    const h = health && typeof health.get === 'function' ? health.get(m.id) : null;
    const coolingDown = Boolean(h && h.cooldownUntil > nowFn());
    const reasoning = !preferredId && isReasoningModel(m && m.id);
    return { m, index, h, coolingDown, reasoning };
  });
  scored.sort((a, b) => {
    if (preferredId) {
      if (a.m.id === preferredId && b.m.id !== preferredId) return -1;
      if (b.m.id === preferredId && a.m.id !== preferredId) return 1;
    }
    if (a.coolingDown !== b.coolingDown) return a.coolingDown ? 1 : -1;
    if (a.reasoning !== b.reasoning) return a.reasoning ? 1 : -1;
    const af = a.h ? a.h.failCount : 0;
    const bf = b.h ? b.h.failCount : 0;
    if (af !== bf) return af - bf;
    const as = a.h && typeof a.h.lastFirstByteMs === 'number' ? a.h.lastFirstByteMs : Infinity;
    const bs = b.h && typeof b.h.lastFirstByteMs === 'number' ? b.h.lastFirstByteMs : Infinity;
    if (as !== bs) return as - bs;
    return a.index - b.index;
  });
  return scored.map((s) => s.m);
}

/** 把父级 AbortSignal 链接到子控制器；返回解绑函数。 */
function linkSignal(parent, child) {
  if (!parent || typeof child !== 'object') return () => {};
  if (parent.aborted) { try { child.abort(); } catch { /* 已中止 */ } return () => {}; }
  if (typeof parent.addEventListener === 'function') {
    const onAbort = () => { try { child.abort(); } catch { /* 已中止 */ } };
    parent.addEventListener('abort', onAbort, { once: true });
    return () => { try { parent.removeEventListener('abort', onAbort); } catch { /* 忽略 */ } };
  }
  return () => {};
}

/**
 * 故障转移主循环：依次尝试组内成员，直到某个成员产出非错误 finish。
 * 每个成员都有「首包看门狗」：在 firstByteTimeoutMs 内一个字节都没到，就中止并切下一个，
 * 从而把用户看到的“30 秒卡死”变成有界、快速的自动切换。
 * @param {object} options GenerateOptions（含 provider/model/messages/signal/sessionId 等）
 * @param {{
 *   streamChild:(childOptions:object)=>AsyncIterable<any>,
 *   health?:any,
 *   candidates:Array<{id:string,name?:string}>,
 *   childProvider?:string,
 *   skipCooling?:boolean,
 *   firstByteTimeoutMs?:number,
 *   onAttempt?:(info:{member:any,error:any,emitted:boolean,sessionId?:string})=>void,
 *   onFailover?:(info:{from:any,to?:any,error:any,sessionId?:string,exhausted?:boolean})=>void,
 * }} deps
 */
export async function* runFailover(options, deps) {
  const parentSignal = options && options.signal;
  const health = deps.health;
  const sessionId = options && options.sessionId;
  const skipCooling = Boolean(deps.skipCooling);
  const rawFirstByteTimeout = typeof deps.firstByteTimeoutMs === 'function' ? deps.firstByteTimeoutMs() : deps.firstByteTimeoutMs;
  const firstByteTimeoutMs = Number.isFinite(rawFirstByteTimeout) ? rawFirstByteTimeout : 15000;
  const rawFirstTextTimeout = typeof deps.firstTextTimeoutMs === 'function' ? deps.firstTextTimeoutMs() : deps.firstTextTimeoutMs;
  const firstTextTimeoutMs = Number.isFinite(rawFirstTextTimeout) ? rawFirstTextTimeout : 30000;
  // 「自动」模式（选中虚拟 AUTO 成员）不指定真实首选：preferredId 置空，才会走纯健康排序
  // 并把思考型模型排到后面。否则 '__auto__' 作为真值会误导排序。
  const rawPreferred = options && options.model;
  const preferredForRank = isAutoMemberId(rawPreferred) ? '' : rawPreferred;
  const order = rankMembers(deps.candidates, health, preferredForRank);

  // 两轮尝试：
  //  第 1 轮 —— 只试「未冷却」的成员（正常路径）。
  //  第 2 轮 —— 若第 1 轮确实试过成员、却没有任何可见正文产出，就把「冷却中」的成员
  //             也当最后手段补试一遍。这样即便大部分成员因首包超时被熔断、只剩一个
  //             「只思考不出正文」的成员，也不会把空回答直接甩给用户。
  const totalRounds = skipCooling ? 1 : 2;
  const tried = new Set();
  let attempted = 0;
  let lastFailure = null;
  let lastTriedMember = null;
  let prevMemberId = '';

  for (let round = 0; round < totalRounds; round += 1) {
    const includeCooling = round === 1;
    if (includeCooling && attempted === 0) break; // 第 1 轮一个都没试，谈不上“兜底重试”

    for (const member of order) {
      if (parentSignal && parentSignal.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request cancelled' } } };
        return;
      }
      if (tried.has(member.id)) continue;
      const cooling = Boolean(health && typeof health.isCoolingDown === 'function' && health.isCoolingDown(member.id));
      if (includeCooling ? !cooling : cooling) continue;

      attempted += 1;
      tried.add(member.id);
      const wasFailover = attempted > 1;
      const failoverFrom = wasFailover ? prevMemberId : '';
      prevMemberId = member.id;
      lastTriedMember = member;
      const controller = new AbortController();
      const unlink = linkSignal(parentSignal, controller);
      let gotFirstByte = false;
      let timedOut = false;
      let textTimedOut = false;
      const timer = firstByteTimeoutMs > 0
        ? setTimeout(() => { if (!gotFirstByte) { timedOut = true; try { controller.abort(); } catch { /* 忽略 */ } } }, firstByteTimeoutMs)
        : null;
      // 「首段可见正文」看门狗：模型可能首字节很快（吐思考），却长时间产不出任何正文，
      // 把整个输出预算全烧在 reasoning 上。超过 firstTextTimeoutMs 仍无正文就中止并切换，
      // 无论后面还有没有备份成员都要生效 —— 否则用户会干等好几分钟才看到“输出 token 上限”。
      let textTimer = null;
      let emitted = false;      // 是否已向用户吐出过可见正文（一旦为真就不再无痕切换）
      let failure = null;
      let firstByteMs = 0;
      let lastUsage = null;
      let sawFinish = null;
      // 在产出第一段「可见正文」之前，先把块缓存起来：若该成员最终只有思考、没有正文，
      // 就能整段丢弃、静默切换，用户不会看到半截思考或空回答。
      const buffer = [];
      const childOptions = { ...options, provider: deps.childProvider || 'nvidia', model: member.id, signal: controller.signal };
      const startedAt = Date.now();

      try {
        for await (const chunk of deps.streamChild(childOptions)) {
          if (!gotFirstByte) {
            gotFirstByte = true;
            firstByteMs = Date.now() - startedAt;
            if (timer) clearTimeout(timer);
            if (firstTextTimeoutMs > 0) {
              textTimer = setTimeout(() => { if (!emitted) { textTimedOut = true; try { controller.abort(); } catch { /* 忽略 */ } } }, firstTextTimeoutMs);
            }
          }
          if (isErrorFinish(chunk)) {
            failure = (chunk.reason && chunk.reason.failure) || { code: 'MEMBER_ERROR', message: 'Model returned an error' };
            break;
          }
          if (chunk && chunk.type === 'usage' && chunk.usage) lastUsage = chunk.usage;
          if (chunk && chunk.type === 'finish') sawFinish = chunk;

          if (!emitted) {
            if (isVisibleOutputChunk(chunk)) {
              // 第一段正文到达：把之前缓存的块按顺序补发，然后转入实时直通。
              emitted = true;
              if (textTimer) { clearTimeout(textTimer); textTimer = null; }
              for (const b of buffer) yield b;
              buffer.length = 0;
              yield chunk;
            } else {
              buffer.push(chunk);
            }
          } else {
            yield chunk;
          }
          if (sawFinish) break;
        }
      } catch (error) {
        failure = timedOut
          ? { code: 'FIRST_BYTE_TIMEOUT', message: 'First-byte timeout (' + firstByteTimeoutMs + 'ms), failed over' }
          : { code: 'MEMBER_THROW', message: describeError(error) };
      } finally {
        if (timer) clearTimeout(timer);
        if (textTimer) clearTimeout(textTimer);
        unlink();
      }

      // 看门狗主动中止时，子流往往报成 “network aborted”，诊断信息不清晰；
      // 这里以看门狗为准，统一记为「首包超时 / 首段正文超时」，原始错误码留在 cause 里。
      if (timedOut) {
        failure = {
          code: 'FIRST_BYTE_TIMEOUT',
          message: 'First-byte timeout (' + firstByteTimeoutMs + 'ms), failed over',
          cause: failure || undefined,
        };
      } else if (textTimedOut && !emitted) {
        failure = {
          code: 'FIRST_TEXT_TIMEOUT',
          message: 'First-text timeout (' + firstTextTimeoutMs + 'ms), failed over',
          cause: failure || undefined,
        };
      }

      // 没有产出任何可见正文（典型是“把输出预算全烧在思考上、正文为空”）——
      // 无论后面还有没有备份成员，都判为 EMPTY_ANSWER：绝不能把空的/纯思考的结果
      // 静默当成正常回答交给用户（那正是“没有输出内容 + 已达到输出 token 上限”的成因）。
      if (!emitted && !failure) {
        const inner = (sawFinish && sawFinish.reason) || null;
        const reasonNote = inner && inner.kind === 'max-tokens' ? ' (output budget spent on reasoning, no visible text)' : ' (no visible text produced)';
        failure = {
          code: 'EMPTY_ANSWER',
          message: 'Model produced no text' + reasonNote + ', failed over',
        };
      }

      if (!failure) {
        // 走到这里一定已经产出过可见正文（否则上面已判 EMPTY_ANSWER）。
        if (health && typeof health.recordSuccess === 'function') health.recordSuccess(member.id, firstByteMs);
        if (typeof deps.onAttempt === 'function') {
          try { deps.onAttempt({ member, error: null, emitted, sessionId, firstByteMs, elapsedMs: Date.now() - startedAt, usage: lastUsage, failover: wasFailover, failoverFrom }); } catch { /* 观测失败不影响主流程 */ }
        }
        if (!sawFinish) yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      lastFailure = failure;
      // 致命错误（如缺 API Key）：对所有成员都一样，换模型无用——立即停止，如实把友好提示交给用户。
      if (isFatalFailure(failure)) {
        if (typeof deps.onAttempt === 'function') {
          try { deps.onAttempt({ member, error: failure, emitted, sessionId, firstByteMs, elapsedMs: Date.now() - startedAt, usage: null, fatal: true }); } catch { /* 忽略 */ }
        }
        yield { type: 'finish', reason: { kind: 'error', failure: toFailure(failure) } };
        return;
      }
      // 「能力不符 / 空回答 / 首段正文超时」不是模型“坏了”，而是这次请求不称职：不记熔断，直接换下一个成员。
      const capability = isCapabilityMismatch(failure) || failure.code === 'EMPTY_ANSWER' || failure.code === 'FIRST_TEXT_TIMEOUT';
      if (!capability && health && typeof health.recordFailure === 'function') health.recordFailure(member.id, failure);
      if (typeof deps.onAttempt === 'function') {
        try { deps.onAttempt({ member, error: failure, emitted, sessionId, firstByteMs, elapsedMs: Date.now() - startedAt, usage: null, failover: wasFailover, failoverFrom, capability }); } catch { /* 观测失败不影响主流程 */ }
      }

      if (emitted) {
        // 已向用户产出内容，无法无痕切换，如实返回错误。
        yield { type: 'finish', reason: { kind: 'error', failure: toFailure(lastFailure) } };
        return;
      }
      if (typeof deps.onFailover === 'function') {
        try { deps.onFailover({ from: member, to: null, error: failure, sessionId, capability, exhausted: false }); } catch { /* 忽略 */ }
      }
    }
  }

  if (attempted === 0) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ALL_MEMBERS_COOLING', message: 'All group members are in circuit-breaker cooldown; please retry later or probe to recover' } },
    };
    return;
  }
  const finalFailure = toFailure(lastFailure || { code: 'ALL_MEMBERS_FAILED', message: 'All group members failed' });
  if (lastFailure && lastFailure.code === 'EMPTY_ANSWER') {
    // 最后一个失败是“只思考没正文”：给出明确、可操作的提示，而不是含糊的“模型组均失败”。
    finalFailure.code = 'EMPTY_ANSWER';
    finalFailure.message = 'All group members produced no visible text (reasoning models spent output budget on thinking); please retry, increase maxTokens, or use a non-reasoning model';
  }
  if (typeof deps.onFailover === 'function') {
    try { deps.onFailover({ from: lastTriedMember, to: null, error: finalFailure, sessionId, exhausted: true }); } catch { /* 忽略 */ }
  }
  yield { type: 'finish', reason: { kind: 'error', failure: finalFailure } };
}

function toFailure(failure) {
  const message = describeError(failure);
  const code = (failure && failure.code) || 'ALL_MEMBERS_FAILED';
  return { code, message };
}

/** 判断一次请求是否含有图片输入（据此只路由到多模态成员）。 */
export function requestHasImage(options) {
  const messages = (options && options.messages) || [];
  for (const msg of messages) {
    const content = msg && msg.content;
    if (!content) continue;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && (part.type === 'image' || part.type === 'image-url' || part.type === 'input-image')) return true;
      }
    }
  }
  return false;
}

/** 成员是否具备视觉/图片输入能力。 */
export function memberSupportsImage(member) {
  const mods = (member && member.inputModalities) || [];
  if (mods.includes('image')) return true;
  // 防御：未标注模态时按 id 名称兜底推断。
  return /vision|vl\b|omni|diffusion|image/i.test(String((member && member.id) || ''));
}

/**
 * 构造一个 DSH LlmAdapter 形态的“模型组”适配器。deps 全部注入，便于测试。
 * @param {{
 *   groupId?:string, groupName?:string,
 *   getMembers:()=>Promise<Array<{id:string,name?:string,description?:string,inputModalities?:string[]}>>,
 *   streamChild:(childOptions:object)=>AsyncIterable<any>,
 *   health:any, childProvider?:string, firstByteTimeoutMs?:number,
 *   onAttempt?:Function, onFailover?:Function,
 * }} deps
 */
export function createGroupAdapter(deps) {
  const groupName = deps.groupName || 'NVIDIA Group';
  const getMembers = deps.getMembers;
  const adapter = {
    providerInfo(provider) { return { id: provider, name: groupName }; },
    providerRetryPolicy() { return undefined; },
    async listModels(provider) {
      const members = await getMembers();
      // 虚拟「自动」成员放在第一位：用户选择它即表示「不指定首选、纯按实时健康排序」。
      const auto = { provider, id: AUTO_MEMBER_ID, name: AUTO_MEMBER_NAME, description: AUTO_MEMBER_DESC };
      return [auto, ...members.map((m) => {
        const out = { provider, id: m.id, name: m.name || m.id };
        if (m.description) out.description = m.description;
        if (Array.isArray(m.inputModalities) && m.inputModalities.length) out.inputModalities = m.inputModalities;
        return out;
      })];
    },
    async resolveModel(provider, model) {
      const members = await getMembers();
      if (isAutoMemberId(model)) {
        // 「自动」是个虚拟成员：取组内上报的最大上下文窗口，绝不虚假声明成 128K
        // （声明过小会让 pi-ai 在本会话这种长上下文下误判为溢出）。
        let maxCtx = 0;
        for (const m of members) {
          if (Number.isFinite(m.contextWindow) && m.contextWindow > maxCtx) maxCtx = m.contextWindow;
        }
        const autoCtx = maxCtx > 0 ? maxCtx : 1048576;
        return {
          provider,
          id: model,
          name: AUTO_MEMBER_NAME,
          description: AUTO_MEMBER_DESC,
          context: { contextWindow: autoCtx },
          defaultMaxTokens: 8192,
        };
      }
      const hit = members.find((m) => m.id === model) || {};
      const info = { provider, id: model, name: hit.name || model };
      if (hit.description) info.description = hit.description;
      if (Array.isArray(hit.inputModalities) && hit.inputModalities.length) info.inputModalities = hit.inputModalities;
      if (Number.isFinite(hit.contextWindow) && hit.contextWindow > 0) info.context = { contextWindow: Math.round(hit.contextWindow) };
      if (Number.isFinite(hit.maxTokens) && hit.maxTokens > 0) info.defaultMaxTokens = Math.round(hit.maxTokens);
      return info;
    },
    async prepareCall(provider, model) {
      const resolved = await adapter.resolveModel(provider, model);
      return { model: resolved, stream: (options) => adapter.stream(options) };
    },
    stream(options) {
      const sessionId = options && options.sessionId;
      return (async function* () {
        let members = [];
        try {
          members = await getMembers();
        } catch {
          members = [];
        }
        if (!members.length) {
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: { code: 'EMPTY_GROUP', message: 'NVIDIA Group currently has no available members; detect and configure models in the panel first' } },
          };
          return;
        }
        const pickAuto = isAutoMemberId(options && options.model);
        const current = pickAuto ? null : members.find((m) => m.id === (options && options.model));
        // 手动选中具体模型 = 锁定该模型：候选只保留它本身，不做任何自动故障转移。
        // 这样失败就如实报错，不会悄悄切到别的成员、也不会在面板"自动切换"里计数。
        // 只有选「模型组（自动）」时才把全部成员交给故障转移引擎轮询。
        let candidates = current ? [current] : members;
        // 能力感知路由（软过滤）：含图片的请求**优先**把多模态成员排到前面，
        // 但保留全部成员作为后备。绝不把组员砍到只剩"看起来支持图片"的那几个——
        // id 正则判断并不可靠（如 muse-glimmer 实为多模态却被判为纯文本），
        // 一旦把其余成员剔除，组里常常只剩 1~2 人，一个抖动就整轮失败。
        // 纯文本成员若真的收到图片，会由上游报 400，isCapabilityMismatch 归为
        // INVALID_REQUEST 类 → 直接换下一个且不熔断，代价可控。
        if (requestHasImage(options)) {
          const visionCapable = candidates.filter((m) => memberSupportsImage(m));
          const rest = candidates.filter((m) => !memberSupportsImage(m));
          if (visionCapable.length) candidates = [...visionCapable, ...rest];
        }
        const onAttempt = deps.onAttempt
          ? (info) => deps.onAttempt({ ...info, sessionId })
          : undefined;
        const onFailover = deps.onFailover
          ? (info) => deps.onFailover({ ...info, sessionId })
          : undefined;
        yield* runFailover(options, {
          streamChild: deps.streamChild,
          health: deps.health,
          candidates,
          childProvider: deps.childProvider || 'nvidia',
          firstByteTimeoutMs: deps.firstByteTimeoutMs,
          firstTextTimeoutMs: deps.firstTextTimeoutMs,
          onAttempt,
          onFailover,
        });
      })();
    },
  };
  return adapter;
}

/* ───────────────────────── 会话投影状态（无 zod，自带校验） ───────────────────────── */

/** 空投影状态。 */
export function createGroupState() {
  return { members: {}, timeline: [] };
}

/** 手工校验/规整投影状态：只容许预期形状，异常输入回落到空状态。 */
export function parseGroupState(value) {
  if (!value || typeof value !== 'object') return createGroupState();
  const members = {};
  const rawMembers = value.members && typeof value.members === 'object' ? value.members : {};
  for (const id of Object.keys(rawMembers)) {
    const e = rawMembers[id];
    if (!e || typeof e !== 'object') continue;
    members[id] = {
      status: typeof e.status === 'string' ? e.status : 'unknown',
      failCount: Number.isFinite(e.failCount) ? e.failCount : 0,
      lastError: typeof e.lastError === 'string' ? e.lastError : '',
      cooldownUntil: Number.isFinite(e.cooldownUntil) ? e.cooldownUntil : 0,
      lastSuccessAt: Number.isFinite(e.lastSuccessAt) ? e.lastSuccessAt : null,
    };
  }
  const timeline = Array.isArray(value.timeline)
    ? value.timeline.filter((t) => t && typeof t === 'object').slice(-30).map((t) => ({
        at: Number.isFinite(t.at) ? t.at : 0,
        type: typeof t.type === 'string' ? t.type : 'event',
        member: typeof t.member === 'string' ? t.member : '',
        to: typeof t.to === 'string' ? t.to : '',
        error: typeof t.error === 'string' ? t.error : '',
      }))
    : [];
  return { members, timeline };
}

/** 一个满足 `.parse()` 契约的极简 schema（避免引入 zod 依赖）。 */
export function makeSchema() {
  return { parse: (value) => parseGroupState(value) };
}

// 事件类型名：新版走 harness 官方 plugin record（plugin: 命名空间 + 自动
// ignorable），旧版遗留 nvidia-group/* 仍需识别以便回放历史会话。
const PROBE_TYPES = new Set(['nvidia-group/probe', 'plugin:dsh-nvidia-models-panel/probe']);
const FAILOVER_TYPES = new Set(['nvidia-group/failover', 'plugin:dsh-nvidia-models-panel/failover']);

/** 把一条组事件（新旧类型名）折进投影状态。 */
export function foldGroupEvent(state, event) {
  const s = parseGroupState(state);
  const type = event && event.type;
  const data = (event && event.data) || {};
  const at = Number.isFinite(event && event.time) ? event.time : Date.now();
  if (FAILOVER_TYPES.has(type)) {
    const from = String(data.from || '');
    const to = String(data.to || '');
    const members = { ...s.members };
    if (from) {
      const prev = members[from] || { status: 'unknown', failCount: 0, lastError: '', cooldownUntil: 0, lastSuccessAt: null };
      members[from] = { ...prev, status: 'failed', failCount: (prev.failCount || 0) + 1, lastError: String(data.error || prev.lastError || '') };
    }
    if (to) {
      const prev = members[to] || { status: 'unknown', failCount: 0, lastError: '', cooldownUntil: 0, lastSuccessAt: null };
      members[to] = { ...prev, status: 'ok', failCount: 0, lastSuccessAt: at };
    }
    const timeline = s.timeline.concat([{ at, type: 'failover', member: from, to, error: String(data.error || '') }]).slice(-30);
    return { members, timeline };
  }
  if (PROBE_TYPES.has(type)) {
    const id = String(data.member || '');
    if (!id) return s;
    const members = { ...s.members };
    const prev = members[id] || { status: 'unknown', failCount: 0, lastError: '', cooldownUntil: 0, lastSuccessAt: null };
    members[id] = {
      ...prev,
      status: data.status === 'ok' ? 'ok' : (data.status === 'fail' ? 'failed' : prev.status),
      lastError: data.status === 'fail' ? String(data.error || prev.lastError || '') : (data.status === 'ok' ? '' : prev.lastError),
      lastSuccessAt: data.status === 'ok' ? at : prev.lastSuccessAt,
    };
    return { members, timeline: s.timeline };
  }
  if (type === 'nvidia-group/reset') return createGroupState();
  return s;
}
