/** Host half of the Nvidia Models Panel bundle. */

import {
  createHealthRegistry,
  createGroupAdapter,
  createGroupState,
  makeSchema,
  foldGroupEvent,
  AUTO_MEMBER_ID,
  AUTO_MEMBER_NAME,
  AUTO_MEMBER_DESC,
  isAutoMemberId,
} from './group.js';

import { createUsageRegistry } from './usage.js';

export const inject = ['commands', 'configEditor'];

/** NVIDIA NIM public endpoints (model list is anonymous-readable; completions need a key). */
const NIM_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';
const ONE_BALANCE_COMPLETIONS_URL = 'https://one-balance.eplani.com.tr/api/compat/chat/completions';

/**
 * 旧版「一键配置」给所有模型硬编码的上下文窗口（131072 = 128K）。
 * 绝大多数 NVIDIA NIM 模型的 /v1/models 不返回 context_window，这个 128K 的
 * 保守值会让 pi-ai 在本会话这种长上下文下误判为「silent context overflow」，
 * 把一次正常应答报成致命的 CONTEXT_WINDOW_EXCEEDED。见 inferContextWindow。
 */
const LEGACY_CONTEXT_WINDOW = 131072;

/**
 * 未上报 context_window 时的宽松默认窗口。宁可声明得宽松一点：
 * 声明过小 → pi-ai 误判溢出（假失败）；声明偏大 → 真超长时上游返回真实报错（诚实失败）。
 */
const DEFAULT_CONTEXT_WINDOW = 1048576;

/**
 * 解析某模型应使用的上下文窗口：优先用上游 /v1/models 上报的 context_window，
 * 缺省时按模型族给合理值，最后回落到宽松默认，绝不沿用旧的 128K。
 * 导出以便单测。
 * @param {string} id 模型 id
 * @param {number} [upstreamCtx] 上游上报的 context_window（若有）
 */
export function inferContextWindow(id, upstreamCtx) {
  if (Number.isFinite(upstreamCtx) && upstreamCtx > 0) return Math.round(upstreamCtx);
  const s = String(id || '');
  // 明确的长上下文模型族。
  if (/deepseek-v4|nemotron-3-ultra|nemotron-3\.5-(super|ultra)|llama-3\.1|mistral-large/i.test(s)) return 1048576;
  if (/nemotron|llama|mistral|qwen|glm|kimi|step|minimax|gpt-oss|muse/i.test(s)) return 262144;
  return DEFAULT_CONTEXT_WINDOW;
}

/** Chinese blurbs per publisher prefix, used to build per-model descriptions. */
const PUBLISHER_BLURBS = {
  nvidia: 'NVIDIA 官方',
  'nv-mistralai': 'NVIDIA 与 Mistral 联合优化',
  meta: 'Meta Llama 系列',
  'deepseek-ai': 'DeepSeek 系列',
  'z-ai': '智谱 GLM 系列',
  moonshotai: '月之暗面 Kimi 系列',
  qwen: '阿里通义千问系列',
  google: 'Google 开源模型',
  microsoft: '微软 Phi 系列',
  mistralai: 'Mistral AI 系列',
  openai: 'OpenAI 开源模型',
  '01-ai': '零一万物 Yi 系列',
  ai21labs: 'AI21 Jamba 系列',
  ibm: 'IBM Granite 系列',
  bigcode: 'BigCode 代码模型',
  databricks: 'Databricks 模型',
  snowflake: 'Snowflake Arctic 系列',
  writer: 'Writer Palmyra 系列',
  poolside: 'Poolside 代码模型',
  minimaxai: 'MiniMax 系列',
  'stepfun-ai': '阶跃星辰系列',
  zyphra: 'Zyphra 系列',
  adept: 'Adept 模型',
  aisingapore: 'AI Singapore SEA-LION 系列',
};

/** Built-in fallback shown when the upstream API is unreachable. */
const BUILTIN_MODELS = [
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Llama 3.1 Nemotron 70B', description: 'NVIDIA 旗舰推理模型，擅长复杂推理、编码与数学' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', description: 'NVIDIA 官方超大参数模型，推理与编码能力极强' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', description: 'NVIDIA 官方高性能均衡型，适合企业级任务' },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B', description: 'NVIDIA 官方轻量高速 MoE，响应快成本低' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano Omni 30B', description: 'NVIDIA 官方全模态模型，支持文本与图像' },
  { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: 'DeepSeek 系列，长上下文，支持文本与图像' },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3', description: '月之暗面 Kimi 系列，百万级上下文窗口' },
  { id: 'z-ai/glm-5.3', name: 'GLM-5.3', description: '智谱 GLM 系列，强推理与长上下文' },
  { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision', description: 'Meta Llama 系列，多语言视觉理解' },
  { id: 'mistralai/mistral-7b-instruct-v0.3', name: 'Mistral 7B Instruct v0.3', description: 'Mistral AI 系列，轻量高效通用模型' },
];

/** Build a short Chinese blurb for one model id. */
function describeModel(id) {
  const slash = id.indexOf('/');
  const publisher = slash > 0 ? id.slice(0, slash) : '';
  const bare = slash > 0 ? id.slice(slash + 1) : id;
  const who = PUBLISHER_BLURBS[publisher] || (publisher ? publisher + ' 发布' : 'NVIDIA NIM 托管');
  let kind = '通用大语言模型';
  const lower = bare.toLowerCase();
  if (/vision|vl|omni|diffusion|image/.test(lower)) kind = '支持视觉/多模态输入';
  else if (/coder|code/.test(lower)) kind = '专攻代码生成与补全';
  else if (/embed|rerank|reward/.test(lower)) kind = '检索/评测类模型';
  else if (/reason|thinking|r1/.test(lower)) kind = '强化推理能力';
  return who + '，' + kind + '。';
}

/** True for model families the chat-completions probe cannot meaningfully call. */
function isNonChatModel(id) {
  // embed/rerank/reward/diffusion——不是对话模型；
  // guard/safety/calibration/parse/translate——是专用模型，放进模型组只会每一轮都失败。
  return /embed|rerank|reward|diffusion|guard|safety|calibration|nemotron-parse|riva-translate/i.test(String(id || ''));
}

/** Context-bound key resolver installed during apply(); prefers env, then the credential store. */
let resolveKeyFromContext = async () => '';

/** Run one operation against the credentials service; resolves null when unavailable. */
function withCredentials(ctx, operation) {
  return new Promise((done) => {
    try {
      ctx.inject(['credentials'], (scoped) => {
        try {
          done(Promise.resolve(operation(scoped.credentials)).catch(() => null));
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

/** NVIDIA Key 是否已配置（凭据服务不可用时按「已配置」处理，避免误拦截）。 */
async function hasNvidiaKey(ctx) {
  const info = await withCredentials(ctx, (credentials) => credentials.describe(NVIDIA_KEY_REF));
  if (!info || info.unavailable) return true; // 无法判定时不拦截，交给上游返回真实错误
  return Boolean(info.configured);
}

/** Run one operation against the configEditor service; resolves null when unavailable. */
function withConfigEditor(ctx, operation) {
  return new Promise((done) => {
    try {
      ctx.inject(['configEditor'], (scoped) => {
        try {
          done(Promise.resolve(operation(scoped.configEditor)).catch(() => null));
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

const LLM_PLUGIN_NAME = '@deepseek-ai/dsh-llm-pi-ai';

/**
 * configEditor.entries() yields Loader Entry objects, so the plugin identity
 * lives at entry.options.id / entry.options.name (see dsh-config-editor
 * lib/index.js entries() and edit()). Tolerant of the other plausible shapes.
 */
function entryIdentifiers(entry) {
  const values = [];
  const push = (value) => { if (typeof value === 'string' && value) values.push(value); };
  try {
    push(entry.id);
    push(entry.name);
    const options = entry.options;
    if (options && typeof options === 'object') {
      push(options.id);
      push(options.name);
      push(options.group);
    }
  } catch {
    // An unreadable entry simply cannot be matched by identifier.
  }
  return values;
}

/** Does this entry address the llm-pi-ai plugin (any id/patchId/name form)? */
function isLlmPiAiEntry(entry) {
  return entryIdentifiers(entry).some((value) =>
    value === LLM_PLUGIN_NAME || value === 'llm-pi-ai' || value.endsWith(':llm-pi-ai'));
}

/** Compact, secret-free dump of entries, used only to diagnose a failed lookup. */
function describeEntries(entries) {
  return entries.slice(0, 20).map((entry) => {
    const out = {};
    try {
      const options = entry.options || {};
      if (typeof options.id === 'string') out.id = options.id;
      if (typeof options.name === 'string') out.name = options.name;
      if (options.config !== undefined) out.hasConfig = true;
      if (entry.fiber) out.active = entry.fiber.state === 2;
    } catch {
      out.unreadable = true;
    }
    return out;
  });
}

/**
 * Detect models live and write the AVAILABLE ones into the llm-pi-ai nvidia
 * provider, so the chat model picker offers exactly what can be called.
 * Shared by the panel button (POST action=configure) and the slash command.
 * `probeResults` (id → 'ok' | 'unavailable') from the panel's per-model probe
 * filters the list; without it, non-chat families are the only ones dropped.
 */
async function configureNvidiaModels(ctx, probeResults) {
  const configEditor = await withConfigEditor(ctx, (editor) => editor);
  if (!configEditor) {
    return { ok: false, error: 'configEditor 服务不可用，无法写入配置' };
  }
  const detection = await detectNvidiaModels();
  const allModels = detection.models;
  if (detection.source === 'live') lastDetectedModels = normalizeGroupMembers(allModels);
  const source = detection.source === 'live' ? 'NVIDIA API 实时检测' : '内置目录';
  let available;
  let droppedUnavailable = 0;
  let droppedNonChat = 0;
  if (probeResults && typeof probeResults === 'object' && Object.keys(probeResults).length > 0) {
    available = allModels.filter((m) => probeResults[m.id] === 'ok');
    droppedUnavailable = allModels.length - available.length;
  } else {
    available = allModels.filter((m) => !isNonChatModel(m.id));
    droppedNonChat = allModels.length - available.length;
  }
  if (available.length === 0) {
    return { ok: false, error: '没有试调用通过的可用模型，未写入。请先确认 API Key 有效后重新试调用。' };
  }
  // Locate the llm-pi-ai row by identity across every plausible field and
  // fall back to the configuration() projection before giving up.
  let entries;
  try {
    entries = configEditor.entries();
  } catch (error) {
    return { ok: false, error: '读取配置条目失败：' + String((error && error.message) || error) };
  }
  if (!Array.isArray(entries)) {
    return { ok: false, error: '配置条目返回异常：' + JSON.stringify(entries).slice(0, 200) };
  }
  let configs = [];
  try {
    configs = configEditor.configuration();
  } catch {
    configs = [];
  }
  let llmEntry = entries.find(isLlmPiAiEntry);
  let llmHit = null;
  if (llmEntry) {
    llmHit = (Array.isArray(configs) ? configs : []).find((c) => c && c.entry === llmEntry) || null;
  } else {
    llmHit = (Array.isArray(configs) ? configs : []).find((c) => c && isLlmPiAiEntry(c.entry)) || null;
    if (llmHit) llmEntry = llmHit.entry;
  }
  if (!llmEntry) {
    return {
      ok: false,
      error: '未找到 llm-pi-ai 配置项（entries 共 ' + entries.length + ' 条）。诊断信息：' + JSON.stringify(describeEntries(entries)).slice(0, 900),
    };
  }
  let existingCount = 0;
  if (llmHit && llmHit.override?.providers?.['one-balance-nvidia']) {
    const models = llmHit.override.providers['one-balance-nvidia'].models;
    existingCount = Array.isArray(models) ? models.length : 0;
  }
  const nextModels = available.map((m) => ({
    id: 'custom-nvidia/' + m.id,
    name: m.name + ' - ' + m.description,
    contextWindow: inferContextWindow(m.id, m.upstreamCtx),
    maxTokens: 8192,
    input: /vision|vl|omni|diffusion|image/i.test(m.id) ? ['text', 'image'] : ['text'],
  }));
  try {
    await configEditor.edit(llmEntry, (current, inherited) => {
      // Start from inherited ∪ override so unrelated providers and fields survive.
      const base = { ...(inherited || {}), ...(current || {}) };
      const baseProviders = base.providers || {};
      const baseOneBalanceNvidia =
        baseProviders['one-balance-nvidia'] || {};
      return {
        ...base,
        providers: {
          ...baseProviders,
          'one-balance-nvidia': {
            ...baseOneBalanceNvidia,
            api: baseOneBalanceNvidia.api || 'openai-completions',
            apiKeyEnv: 'ONE_BALANCE_API_KEY',
            baseUrl: 'https://one-balance.eplani.com.tr/api/compat',
            models: nextModels,
          },
        },
      };
    });
  } catch (error) {
    return { ok: false, error: '写入配置失败：' + String((error && error.message) || error) };
  }
  const droppedNote = droppedUnavailable > 0
    ? '，剔除 ' + droppedUnavailable + ' 个试调用未通过的模型'
    : (droppedNonChat > 0 ? '，跳过 ' + droppedNonChat + ' 个非对话模型' : '');
  return {
    ok: true,
    message: '已' + (existingCount ? '更新（原 ' + existingCount + ' 个模型）' : '写入') + ' nvidia 供应商：' + nextModels.length + ' 个【试调用可用】模型' + droppedNote + '（来源：' + source + '）。模型名称后附简介，现在对话框的模型选择器即可选用；凭据与正式路由共用，下一次请求即生效。',
  };
}

/** Query NVIDIA NIM for the live model list; falls back to the built-in catalog. */
async function detectNvidiaModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    /** const apiKey = await resolveKeyFromContext(); */
    const headers = { accept: 'application/json' };
    /** if (apiKey) headers.authorization = 'Bearer ' + apiKey; */
    const upstream = await fetch(NIM_MODELS_URL, { headers, signal: controller.signal });
    if (!upstream.ok) {
      return { ok: false, reason: 'NVIDIA API 返回 HTTP ' + upstream.status, source: 'builtin', models: BUILTIN_MODELS };
    }
    const data = await upstream.json();
    const raw = Array.isArray(data && data.data) ? data.data : [];
    if (raw.length === 0) {
      return { ok: false, reason: 'NVIDIA API 返回了空列表', source: 'builtin', models: BUILTIN_MODELS };
    }
    const models = raw.map((m) => ({
      id: String(m.id || ''),
      name: String(m.id || '').split('/').pop() || String(m.id || ''),
      description: describeModel(String(m.id || '')),
      upstreamCtx: (Number.isFinite(m.context_window) && m.context_window > 0)
        ? m.context_window
        : (Number.isFinite(m.context_length) && m.context_length > 0 ? m.context_length : undefined),
    })).filter((m) => m.id);
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, source: 'live', count: models.length, models };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? '连接超时（15 秒）' : String((error && error.message) || error);
    return { ok: false, reason: '无法访问 NVIDIA API：' + reason, source: 'builtin', models: BUILTIN_MODELS };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one model with a streaming completion call. Availability is decided by
 * the FIRST response byte, not the full completion — thinking models can take
 * a long time to finish, but their first chunk arrives in seconds. The stream
 * is aborted as soon as the first byte lands.
 */
async function probeStreaming(id, apiKey, maxTokens, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    const response = await fetch(ONE_BALANCE_COMPLETIONS_URL, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: id.startsWith('custom-nvidia/') ? id : 'custom-nvidia/' + id,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: maxTokens,
        stream: true,
      }),
    });
    if (!response.ok) {
      return { kind: 'http-error', response };
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      // No streaming body support: a 200 still means the endpoint accepted the model.
      return { kind: 'ok-no-stream' };
    }
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      if (first && first.done) {
        return { kind: 'ok-no-stream' };
      }
      return { kind: 'ok-stream' };
    } finally {
      try { reader.releaseLock(); } catch { /* the abort below already tore the stream down */ }
      controller.abort();
    }
  } catch (error) {
    return { kind: 'network-error', error };
  } finally {
    clearTimeout(timer);
  }
}

/** Extract NVIDIA's error message from a failed response, best-effort. */
async function extractErrorHint(response) {
  try {
    const raw = (await response.text()).trim();
    if (!raw) return '';
    try {
      const errBody = JSON.parse(raw);
      const msg = errBody && (errBody.detail || errBody.message || (errBody.error && errBody.error.message))
        ? String(errBody.detail || errBody.message || errBody.error.message)
        : raw;
      return msg ? '：' + msg.slice(0, 160) : '';
    } catch {
      return '：' + raw.slice(0, 160);
    }
  } catch {
    return '';
  }
}

/**
 * Probe one model with a real completion call. Thinking/reasoning models
 * reject tiny output budgets, so the first attempt uses max_tokens=1024 and
 * a 400/422 response retries once with a larger budget before declaring fail.
 * Availability is confirmed by the first streamed byte, so slow thinkers are
 * not misjudged as timeouts.
 */
async function testNvidiaModel(id) {
  if (isNonChatModel(id)) {
    return { id, status: 'skip', detail: '非对话模型（embed/rerank 等），未试调用' };
  }
  try {
    const apiKey = await resolveKeyFromContext();
    let probe = await probeStreaming(id, apiKey, 1024, 30000);
    if (probe.kind === 'http-error' && (probe.response.status === 400 || probe.response.status === 422)) {
      const firstHint = await extractErrorHint(probe.response);
      probe = await probeStreaming(id, apiKey, 8192, 45000);
      if (probe.kind === 'ok-stream' || probe.kind === 'ok-no-stream') {
        return { id, status: 'ok', detail: '试调用成功（需较大输出预算）' };
      }
      if (probe.kind === 'http-error') {
        const hint = (await extractErrorHint(probe.response)) || firstHint;
        const map = { 401: '鉴权失败（401）——需要有效的 NVIDIA API Key', 403: '无权限（403）——当前密钥无权调用该模型', 404: '模型不可用（404）——端点不接受该模型', 429: '限流（429）——请求过于频繁或配额耗尽' };
        const known = map[probe.response.status];
        return { id, status: 'fail', detail: (known || '调用失败（HTTP ' + probe.response.status + '）') + hint };
      }
      const abortRetry = probe.error && probe.error.name === 'AbortError';
      return { id, status: 'fail', detail: abortRetry ? '首包超时（45 秒无响应）' : '网络错误：' + String((probe.error && probe.error.message) || probe.error) };
    }
    if (probe.kind === 'ok-stream') {
      return { id, status: 'ok', detail: '试调用成功（流式首包确认）' };
    }
    if (probe.kind === 'ok-no-stream') {
      return { id, status: 'ok', detail: '端点返回 200（无流式数据）' };
    }
    if (probe.kind === 'http-error') {
      const hint = await extractErrorHint(probe.response);
      const map = {
        401: '鉴权失败（401）——需要有效的 NVIDIA API Key',
        403: '无权限（403）——当前密钥无权调用该模型',
        404: '模型不可用（404）——端点不接受该模型',
        429: '限流（429）——请求过于频繁或配额耗尽',
      };
      const known = map[probe.response.status];
      return { id, status: 'fail', detail: (known || '调用失败（HTTP ' + probe.response.status + '）') + hint };
    }
    const abortFirst = probe.error && probe.error.name === 'AbortError';
    return { id, status: 'fail', detail: abortFirst ? '首包超时（30 秒无响应）' : '网络错误：' + String((probe.error && probe.error.message) || probe.error) };
  } catch (error) {
    return { id, status: 'fail', detail: '网络错误：' + String((error && error.message) || error) };
  }
}

/** Read and parse a bounded JSON body; empty or malformed bodies yield {}. */
async function readJsonBody(request) {
  const reader = request && request.body && request.body.getReader ? request.body.getReader() : undefined;
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); return {}; }
      chunks.push(value);
    }
  } catch {
    return {};
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The credential reference this panel manages (matches the llm-pi-ai nvidia route). */
const NVIDIA_KEY_REF = 'ONE_BALANCE_API_KEY';

/* ───────────────────────────── NVIDIA 模型组（自愈式故障转移） ───────────────────────────── */

/**
 * 组内健康登记表（熔断器）。进程级单例：所有会话共享同一份模型健康视图，
 * 这样一个会话把某个模型判定为不可用后，其它会话也会短路跳过它。
 */
const groupHealth = createHealthRegistry({ failThreshold: 2, baseCooldownMs: 20000, maxCooldownMs: 300000 });

/**
 * 调用日志持久化文件（放在 profile 目录而非插件目录）：市场重装会替换 node_modules
 * 里的插件实体目录、放到那里会跟着丢；profile 目录稳定。无 DSH_PROFILE_DIR 时返回空，
 * 静默降级为纯内存（便于测试与非 DSH 环境）。
 */
function defaultUsageFilePath() {
  const dir = process.env.DSH_PROFILE_DIR;
  if (!dir) return '';
  return dir.replace(/\/+$/, '') + '/nvidia-usage.json';
}

/** 文件型 storage（ESM 用动态 import）：全量快照覆盖写，读写失败一律静默。 */
function makeFileStorage() {
  // Never touch the real profile usage file while running under `node --test`
  // (smoke tests exercise apply()/stream and would otherwise pollute it).
  if (process.env.NODE_TEST_CONTEXT) return null;
  const file = defaultUsageFilePath();
  if (!file) return null;
  return {
    async load() {
      try {
        const fs = await import('node:fs/promises');
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch { return null; }
    },
    async save(data) {
      try {
        const fs = await import('node:fs/promises');
        const tmp = file + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
        await fs.rename(tmp, file); // atomic replace
      } catch { /* best-effort */ }
    },
  };
}

/** 当日调用用量登记表（进程级单例）：模型组每次尝试都记一条，供面板「调用日志」展示。 */
const groupUsage = createUsageRegistry({ retentionDays: 7, maxLogPerDay: 200, storage: makeFileStorage() });

/** 组运行参数（内存态，可被 setGroupConfig 覆盖）。 */
const groupConfig = {
  firstByteTimeoutMs: 15000,
  firstTextTimeoutMs: 30000,
  preferredModel: '',
  autoRefreshMs: 300000,
};

/**
 * 输入框 dock 徽标的共享状态（进程级内存，重启归零）。
 * 记录最近一次真正产出正文的成员、最近一次切换来源/时间、累计切换次数，
 * 由 buildGroupAdapter 的 onAttempt / onFailover 更新，route `dockStatus` 暴露给 client。
 */
const dockGroupState = {
  sessionId: null,
  memberId: '',
  memberName: '',
  switchFrom: '',
  switchAt: 0,
  switchCount: 0,
  updatedAt: 0,
};

/** 成员的短友好名（优先配置里的 name，否则取 id 最后一段）。 */
function friendlyMemberName(member) {
  if (!member) return '';
  if (member.name) return String(member.name);
  const id = String(member.id || '');
  const tail = id.split('/').pop();
  return tail || id;
}

/**
 * 自动发现：最近一次实时检测到的模型（面板点「检测」、configure 成功或后台自动刷新时更新）。
 * 组成员解析顺序：已配置模型 → 最近检测到的对话模型 → 内置种子。
 */
let lastDetectedModels = [];

/**
 * 内置“种子”组成员：都是 NVIDIA 官方已验证可流式返回的对话模型，
 * 让模型组在用户尚未「一键配置」时也能立即工作（自愈开箱即用）。
 */
const AUTO_SEED_MODELS = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B', description: 'NVIDIA 官方轻量高速 MoE', inputModalities: ['text'] },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano Omni 30B', description: 'NVIDIA 官方全模态模型', inputModalities: ['text', 'image'] },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', description: 'NVIDIA 官方超大参数模型', inputModalities: ['text'] },
  { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: 'DeepSeek 高速长上下文', inputModalities: ['text', 'image'] },
];

/** 把一组模型条目（id/name/description）规整成组成员形态。 */
function normalizeGroupMembers(list) {
  return (Array.isArray(list) ? list : []).map((m) => ({
    id: String(m.id || ''),
    name: String(m.name || m.id || ''),
    description: String(m.description || ''),
    inputModalities: Array.isArray(m.input) ? m.input : (Array.isArray(m.inputModalities) ? m.inputModalities : (/vision|vl|omni|diffusion|image/i.test(String(m.id || '')) ? ['text', 'image'] : ['text'])),
    // 组成员也不再用「未知即 128K」：优先上游值/推断值，再没有就留 null（不虚假声明）。
    contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : (Number.isFinite(m.upstreamCtx) ? m.upstreamCtx : inferContextWindow(m.id)),
    maxTokens: Number.isFinite(m.maxTokens) ? m.maxTokens : null,
  })).filter((m) => m.id && !isNonChatModel(m.id));
}

/** 解析当前组合成员：已配置 > 最近检测 > 内置种子（自动发现，开箱即用）。 */
async function resolveGroupMembers(ctx) {
  const configured = await readNvidiaConfigModels(ctx);
  if (configured && configured.length) return configured;
  const detected = normalizeGroupMembers(lastDetectedModels);
  if (detected.length) return detected;
  return normalizeGroupMembers(AUTO_SEED_MODELS);
}

/** 从 llm-pi-ai 的 nvidia 供应商配置里读出当前组成员（与 configure 写入的模型列表同源）。 */
async function readNvidiaConfigModels(ctx) {
  const configEditor = await withConfigEditor(ctx, (editor) => editor);
  if (!configEditor) return null;
  let entries;
  try { entries = configEditor.entries(); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  let configs = [];
  try { configs = configEditor.configuration(); } catch { configs = []; }
  let llmHit = (Array.isArray(configs) ? configs : []).find((c) => c && isLlmPiAiEntry(c.entry)) || null;
  if (!llmHit) {
    const llmEntry = entries.find(isLlmPiAiEntry);
    if (llmEntry) llmHit = { entry: llmEntry, override: llmEntry.options && llmEntry.options.config };
  }
  const provider = llmHit?.override?.providers?.['one-balance-nvidia'];
  const models = provider && Array.isArray(provider.models) ? provider.models : [];
  return models.map((m) => {
    const declared = Number.isFinite(m.contextWindow) ? m.contextWindow : (Number.isFinite(m.context) ? m.context : null);
    // 旧版「一键配置」把所有模型写成 131072；这类遗留值按模型族自愈为更合理的窗口，
    // 避免 pi-ai 因声明过小而把正常应答误判成上下文溢出。
    const contextWindow = (declared && declared !== LEGACY_CONTEXT_WINDOW)
      ? declared
      : inferContextWindow(m.id, declared === LEGACY_CONTEXT_WINDOW ? undefined : declared);
    return {
      id: String(m.id || ''),
      name: String(m.name || m.id || ''),
      description: String(m.description || ''),
      inputModalities: Array.isArray(m.input) ? m.input : (m.inputModalities || ['text']),
      contextWindow,
      maxTokens: Number.isFinite(m.maxTokens) ? m.maxTokens : null,
    };
  }).filter((m) => m.id && !isNonChatModel(m.id));
}

/** 取得一个会话对象（best-effort，用于把故障转移事件写进会话投影）。 */
function sessionFor(ctx, sessionId) {
  try {
    const sessions = ctx.get ? ctx.get('sessions') : undefined;
    if (!sessions || typeof sessions.get !== 'function' || !sessionId) return null;
    return sessions.get(sessionId) || null;
  } catch {
    return null;
  }
}

// —— 会话事件写入：只使用 harness 官方的 plugin record API ——
// 背景：session.append() 无法写 ignorable 标记。用它写 harness 词表外的
// 类型（如 nvidia-group/*）会让会话日志下次加载时被持久化层拒绝：
//   "contains event type ... unknown to this harness and not marked ignorable"
// appendPluginRecord() 写的 plugin: 记录会自动带 ignorable:true，未知
// 类型可被安全跳过，不会再把整段会话历史卡死。
const GROUP_RECORD_PROBE = 'plugin:dsh-nvidia-models-panel/probe';
const GROUP_RECORD_FAILOVER = 'plugin:dsh-nvidia-models-panel/failover';
let dshSessionApi; // undefined=未加载；null=不可用；对象={ appendPluginRecord }
function getSessionApi() {
  if (dshSessionApi !== undefined) return Promise.resolve(dshSessionApi);
  return import('@deepseek-ai/dsh-session').then(
    (mod) => (dshSessionApi = typeof mod?.appendPluginRecord === 'function' ? mod : null),
    () => (dshSessionApi = null),
  );
}

/** 把一条组事件作为 plugin record 追加进会话（best-effort；失败不影响主流程）。 */
function appendGroupEvent(ctx, sessionId, type, data) {
  try {
    const session = sessionFor(ctx, sessionId);
    if (!session) return;
    // 旧 harness 没有 appendPluginRecord 时宁可不写，绝不退回
    // session.append() 写不可忽略的未知类型（那会再次损坏会话）。
    void getSessionApi().then((api) => {
      if (!api || typeof api.appendPluginRecord !== 'function') return;
      try { api.appendPluginRecord(session, type, data); } catch { /* best-effort */ }
    });
  } catch {
    // 会话不可用时，看板仍能靠 groupStatus 的实时快照工作。
  }
}

/** 没有 Key / 凭据失效时给出的统一可读提示。 */
const NO_KEY_MESSAGE = 'One-Balance API Key 未配置或已失效，请在 NVIDIA 模型面板顶部保存 Key 后重试。';

/**
 * 包装 llm.stream：把上游的「缺凭据 / 401 / 403」错误翻译成带 NO_API_KEY 码的
 * 友好失败。这类错误对所有成员都一样，group.js 会识别为致命错误直接停止故障转移。
 */
function translateKeyError(failure) {
  if (!failure || typeof failure !== 'object') return failure;
  const code = String(failure.code || '');
  const status = failure.status;
  const msg = String(failure.message || '');
  const isKeyIssue = code === 'MISSING_CREDENTIAL' || code === 'NO_API_KEY'
    || status === 401 || status === 403
    || /api.?key|credential|unauthoriz|authentication|invalid.?token/i.test(msg);
  if (!isKeyIssue) return failure;
  return { code: 'NO_API_KEY', message: NO_KEY_MESSAGE, status };
}

function streamChildWithFriendlyKeyErrors(llm, childOptions) {
  const source = llm.stream(childOptions);
  return (async function* () {
    try {
      for await (const chunk of source) {
        // finish error 块：翻译其 failure。
        if (chunk && chunk.type === 'finish' && chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const failure = translateKeyError(chunk.reason.failure);
          if (failure !== chunk.reason.failure) {
            yield { ...chunk, reason: { ...chunk.reason, failure } };
            continue;
          }
        }
        yield chunk;
      }
    } catch (error) {
      // 抛出的错误里也可能是缺凭据。
      const failure = translateKeyError(error && typeof error === 'object'
        ? { code: error.code, status: error.status, message: error.message }
        : { message: String(error) });
      if (failure && failure.code === 'NO_API_KEY') {
        yield { type: 'finish', reason: { kind: 'error', failure } };
      } else {
        throw error;
      }
    }
  })();
}

/** 构造“模型组”适配器：内部按健康度顺序把请求转给真正的 nvidia 路由。 */
function buildGroupAdapter(ctx, llm) {
  return createGroupAdapter({
    groupId: 'nvidia-group',
    groupName: 'NVIDIA 模型组',
    childProvider: 'one-balance-nvidia',
    getMembers: async () => {
      const members = await resolveGroupMembers(ctx);
      return members;
    },
    // 用注入到的 llm 服务实例直接调用（外层 ctx 未声明注入 llm，不能在请求时访问 ctx.llm）。
    // 同时把「没有 Key / 凭据失效」的上游错误翻译成可读提示——这种错误对所有成员都一样，
    // 由 group.js 识别为致命错误直接停止故障转移，避免无谓地逐个重试。
    streamChild: (childOptions) => {
      const m = String((childOptions && childOptions.model) || '');
      const normalized = m && !m.startsWith('custom-nvidia/') ? 'custom-nvidia/' + m : m;
      return streamChildWithFriendlyKeyErrors(llm, normalized ? { ...childOptions, model: normalized } : childOptions);
    },
    health: groupHealth,
    firstByteTimeoutMs: () => groupConfig.firstByteTimeoutMs,
    firstTextTimeoutMs: () => groupConfig.firstTextTimeoutMs,
    onAttempt: (info) => {
      // dock 徽标：只在「真正产出正文」的成功尝试里更新当前模型名。
      // info.error 为空且 info.emitted 为真代表该成员给出了可见正文（而非纯思考/失败）。
      if (!info.error && info.emitted && info.member) {
        dockGroupState.memberId = String(info.member.id || '');
        dockGroupState.memberName = friendlyMemberName(info.member);
        dockGroupState.sessionId = info.sessionId || dockGroupState.sessionId;
        dockGroupState.updatedAt = Date.now();
      }
      appendGroupEvent(ctx, info.sessionId, GROUP_RECORD_PROBE, {
        member: info.member.id,
        status: info.error ? 'fail' : 'ok',
        error: info.error ? describeErrorSafe(info.error) : '',
      });
      // 当日用量：每个成员每次尝试都记一条（含失败的、被跳过的切换）。
      try {
        const usage = info.usage || {};
        groupUsage.record({
          sessionId: info.sessionId,
          memberId: info.member && info.member.id,
          ok: !info.error,
          failover: Boolean(info.failover),
          failoverFrom: info.failoverFrom || '',
          firstByteMs: info.firstByteMs,
          elapsedMs: info.elapsedMs,
          inputTokens: usage.inputTokens || usage.promptTokens,
          outputTokens: usage.outputTokens || usage.completionTokens,
          error: info.error ? describeErrorSafe(info.error) : '',
        });
      } catch {
        // 统计失败不影响主流程。
      }
    },
    onFailover: (info) => {
      // dock 徽标：记录「刚从哪个模型切换过来」，供几秒内的橙色高亮提示。
      if (info.from) {
        dockGroupState.switchFrom = friendlyMemberName(info.from);
        dockGroupState.switchAt = Date.now();
        dockGroupState.switchCount += 1;
        dockGroupState.sessionId = info.sessionId || dockGroupState.sessionId;
      }
      appendGroupEvent(ctx, info.sessionId, GROUP_RECORD_FAILOVER, {
        from: info.from ? info.from.id : '',
        to: info.to ? info.to.id : '',
        error: info.error ? describeErrorSafe(info.error) : '',
        exhausted: Boolean(info.exhausted),
      });
    },
  });
}

/** 本地小工具：把错误压成短句（不依赖 group.js 的导出细节）。 */
function describeErrorSafe(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  if (error.code) return String(error.code);
  return String(error);
}

/** 组状态快照：组成员 + 健康 + 冷却剩余，供看板渲染。 */
async function groupStatusSnapshot(ctx) {
  const members = (await resolveGroupMembers(ctx)) || [];
  const snapshot = groupHealth.snapshot(members.map((m) => m.id));
  return {
    ok: true,
    group: 'nvidia-group',
    config: { firstByteTimeoutMs: groupConfig.firstByteTimeoutMs, firstTextTimeoutMs: groupConfig.firstTextTimeoutMs, preferredModel: groupConfig.preferredModel },
    members: members.map((m) => {
      const h = snapshot[m.id] || {};
      return {
        id: m.id,
        name: m.name || m.id,
        description: m.description || '',
        status: h.ok === true ? 'ok' : (h.ok === false ? 'failed' : 'unknown'),
        failCount: h.failCount || 0,
        successCount: h.successCount || 0,
        lastError: h.lastError || '',
        cooldownRemainingMs: groupHealth.cooldownRemainingMs(m.id),
        lastFirstByteMs: typeof h.lastFirstByteMs === 'number' ? h.lastFirstByteMs : null,
      };
    }),
  };
}

/** 输入框 dock 徽标状态：当前实际出正文的模型 + 切换/熔断计数。 */
async function dockStatusSnapshot(ctx, sessionId) {
  const members = (await resolveGroupMembers(ctx)) || [];
  const cooling = members.filter((m) => groupHealth.cooldownRemainingMs(m.id) > 0).length;
  // 「刚切换」提示保留 6 秒，之后回落到常态绿色。
  const SWITCH_NOTICE_MS = 6000;
  const justSwitched = Boolean(dockGroupState.switchFrom) && (Date.now() - dockGroupState.switchAt < SWITCH_NOTICE_MS);
  // 当前会话已切到别的模型时隐藏徽标：读会话最新 request/header 的 provider。
  // best-effort：读不到 header 时保持原逻辑，避免误隐藏。
  let currentProvider = '';
  let currentModel = '';
  try {
    const session = sessionFor(ctx, sessionId);
    const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : null;
    if (header && header.config) {
      if (typeof header.config.provider === 'string') {
        currentProvider = header.config.provider;
      }
      if (typeof header.config.model === 'string') {
        currentModel = header.config.model;
      }
    }
  } catch {
    currentProvider = '';
    currentModel = '';
  }
  const usingGroup = !currentProvider || currentProvider === 'nvidia-group';
  // best-effort: 读不到 model 信息时不隐藏；只有明确选了非 auto 的具体模型才隐藏。
  const isAutoModel = !currentModel || isAutoMemberId(currentModel);
  return {
    ok: true,
    active: Boolean(dockGroupState.memberName) && usingGroup && isAutoModel,
    memberName: dockGroupState.memberName || '',
    memberId: dockGroupState.memberId || '',
    switchFrom: justSwitched ? dockGroupState.switchFrom : '',
    switchCount: dockGroupState.switchCount || 0,
    cooldownCount: cooling,
    updatedAt: dockGroupState.updatedAt || 0,
  };
}

/** 探测所有成员（用现有 probeStreaming 快速首包探测），刷新健康表。 */
async function probeGroup(ctx) {
  const members = (await resolveGroupMembers(ctx)) || [];
  const apiKey = await resolveKeyFromContext();
  const out = [];
  for (const m of members) {
    groupHealth.recordProbeStart(m.id);
    const probe = await probeStreaming(m.id, apiKey, 512, 8000);
    if (probe.kind === 'ok-stream' || probe.kind === 'ok-no-stream') {
      groupHealth.recordSuccess(m.id, null);
      out.push({ id: m.id, status: 'ok' });
    } else {
      const detail = probe.kind === 'http-error'
        ? '调用失败（HTTP ' + probe.response.status + '）'
        : (probe.error && probe.error.name === 'AbortError'
          ? '首包超时（8 秒无响应）'
          : '网络错误：' + String((probe.error && probe.error.message) || probe.error));
      groupHealth.recordFailure(m.id, { message: detail });
      out.push({ id: m.id, status: 'fail', detail });
    }
    appendGroupEvent(ctx, null, GROUP_RECORD_PROBE, { member: m.id, status: out[out.length - 1].status === 'ok' ? 'ok' : 'fail', error: out[out.length - 1].detail || '' });
  }
  return { ok: true, probed: out.length, results: out };
}

/** POST /api/nvidia-models — actions: detect | test | keyStatus | setKey | clearKey | configure | groupStatus | probeGroup | resetGroup | getGroupConfig | setGroupConfig | usageStats | resetUsage | checkUpdate | dockStatus. */
function createNvidiaModelsRoute(ctx) {
  return {
    path: '/api/nvidia-models',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJsonBody(request);
      const action = body && typeof body.action === 'string' ? body.action : 'detect';
      let result;
      // 需要 Key 的 action 在没有配置 Key 时统一早退，给出一致的可读提示。
      // keyStatus/setKey/clearKey/resetGroup/resetUsage/checkUpdate 不拦（它们本就用于修复无 Key 状态）。
      const NEED_KEY_ACTIONS = new Set(['test', 'configure', 'probeGroup', 'groupStatus', 'dockStatus', 'usageStats']);
      if (NEED_KEY_ACTIONS.has(action) && !(await hasNvidiaKey(ctx))) {
        result = { ok: false, code: 'NO_API_KEY', message: '未配置 One-Balance API Key，请先在面板上方保存后再继续。' };
      } else if (action === 'test' && typeof body.model === 'string' && body.model) {
        result = await testNvidiaModel(body.model);
      } else if (action === 'keyStatus') {
        const info = await withCredentials(ctx, (credentials) => credentials.describe(NVIDIA_KEY_REF));
        result = info && typeof info === 'object'
          ? { configured: Boolean(info.configured), source: info.source || null, writable: info.writable !== false }
          : { configured: false, source: null, writable: false, unavailable: true };
      } else if (action === 'setKey' && typeof body.key === 'string' && body.key.trim()) {
        const key = body.key.trim();
        const saved = await withCredentials(ctx, async (credentials) => {
          await credentials.set(NVIDIA_KEY_REF, key);
          return credentials.describe(NVIDIA_KEY_REF);
        });
        if (!saved || typeof saved !== 'object') {
          result = { saved: false, error: '凭据服务不可用，无法保存' };
        } else if (!saved.configured) {
          result = { saved: false, error: '保存后校验未通过（凭据存储未确认写入）' };
        } else {
          result = { saved: true, source: saved.source || 'stored' };
        }
      } else if (action === 'clearKey') {
        const cleared = await withCredentials(ctx, async (credentials) => {
          await credentials.unset(NVIDIA_KEY_REF);
          return credentials.describe(NVIDIA_KEY_REF);
        });
        result = cleared && typeof cleared === 'object' && !cleared.configured
          ? { cleared: true }
          : { cleared: false, error: '清除失败或凭据服务不可用' };
      } else if (action === 'configure') {
        result = await configureNvidiaModels(ctx, body.results);
      } else if (action === 'groupStatus') {
        result = await groupStatusSnapshot(ctx);
      } else if (action === 'probeGroup') {
        result = await probeGroup(ctx);
      } else if (action === 'resetGroup') {
        if (typeof body.model === 'string' && body.model) groupHealth.reset(body.model);
        else groupHealth.reset();
        result = await groupStatusSnapshot(ctx);
      } else if (action === 'getGroupConfig') {
        result = { ok: true, config: { ...groupConfig } };
      } else if (action === 'setGroupConfig') {
        if (body.config && typeof body.config === 'object') {
          if (Number.isFinite(body.config.firstByteTimeoutMs) && body.config.firstByteTimeoutMs >= 1000) {
            groupConfig.firstByteTimeoutMs = Math.min(120000, Math.round(body.config.firstByteTimeoutMs));
          }
          if (Number.isFinite(body.config.firstTextTimeoutMs) && body.config.firstTextTimeoutMs >= 5000) {
            groupConfig.firstTextTimeoutMs = Math.min(180000, Math.round(body.config.firstTextTimeoutMs));
          }
          if (typeof body.config.preferredModel === 'string') {
            groupConfig.preferredModel = body.config.preferredModel;
          }
          if (Number.isFinite(body.config.autoRefreshMs) && body.config.autoRefreshMs >= 60000) {
            groupConfig.autoRefreshMs = Math.min(3600000, Math.round(body.config.autoRefreshMs));
          }
        }
        result = { ok: true, config: { ...groupConfig } };
      } else if (action === 'usageStats') {
        result = { ok: true, stats: groupUsage.snapshot(typeof body.day === 'string' && body.day ? body.day : undefined) };
      } else if (action === 'resetUsage') {
        if (typeof body.day === 'string' && body.day) groupUsage.reset(body.day);
        else groupUsage.reset();
        result = { ok: true, stats: groupUsage.snapshot() };
      } else if (action === 'checkUpdate') {
        result = await checkUpdate(ctx);
      } else if (action === 'dockStatus') {
        result = await dockStatusSnapshot(ctx, body.sessionId);
      } else {
        result = await detectNvidiaModels();
        if (result && result.source === 'live') lastDetectedModels = normalizeGroupMembers(result.models);
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

/** Command: write the NVIDIA model list into the llm-pi-ai nvidia provider. */
const GITHUB_REPO = 'akincansenol/dsh-nvidia-models-panel';
const GITHUB_RELEASES_URL = 'https://github.com/' + GITHUB_REPO + '/releases';

/**
 * 读取 GitHub 远端最新版本。
 * 首选 raw.githubusercontent.com 的 HEAD/package.json（也是 dshmarket 的判定方式）——
 * 这个通道不吃 GitHub REST API 的匿名速率限制（每小时 60 次，很容易被耗尽）。
 * 令牌缓存 30 分钟，避免每次挂载面板都发请求。
 */
let _updateCache = { at: 0, version: null };
const UPDATE_CACHE_MS = 30 * 60 * 1000;

async function fetchLatestVersion() {
  if (_updateCache.version && Date.now() - _updateCache.at < UPDATE_CACHE_MS) {
    return _updateCache.version;
  }
  let version = null;
  const url = 'https://raw.githubusercontent.com/' + GITHUB_REPO + '/HEAD/package.json';
  // 网络间歇性抖动时重试一次（github 443 在本机时断时续）。
  for (let attempt = 0; attempt < 2 && !version; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.version === 'string') version = data.version;
      }
    } catch { /* 网络不通，下一轮重试 */ }
    if (!version && attempt === 0) await new Promise((r) => setTimeout(r, 500));
  }
  if (version) _updateCache = { at: Date.now(), version };
  return version;
}

async function checkUpdate(ctx) {
  // 获取插件自身版本（尽力而为，失败不阻塞）。
  let currentVersion = null;
  try {
    const pkg = await readOwnPackageJson();
    if (typeof pkg.version === 'string') currentVersion = pkg.version;
  } catch { /* 忽略 */ }

  let latestVersion = null;
  try {
    latestVersion = await fetchLatestVersion();
  } catch { /* 忽略 */ }
  const reachable = Boolean(latestVersion);

  const latestTag = latestVersion ? ('v' + latestVersion.replace(/^v/, '')) : null;
  const hasUpdate = Boolean(currentVersion && latestVersion && semverGt(latestVersion, currentVersion));
  const message = hasUpdate
    ? ('发现新版本 ' + latestTag + '，当前 ' + currentVersion)
    : (!reachable
      ? '检查失败：暂时无法连接 GitHub（网络问题），请稍后重试'
      : '已是最新版本');
  return {
    ok: true,
    currentVersion,
    latestTag,
    latestUrl: GITHUB_RELEASES_URL,
    hasUpdate,
    reachable,
    message,
  };
}

/** 读取插件自身 package.json 的内容（用于读取当前版本号）。 */
async function readOwnPackageJson() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  // index.js 在 src/ 下，package.json 在上一层；两个候选都试，兼容不同加载布局。
  const candidates = [
    fileURLToPath(new URL('../package.json', import.meta.url)),
    fileURLToPath(new URL('./package.json', import.meta.url)),
  ];
  let lastErr;
  for (const path of candidates) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('package.json not found');
}

/** 语义版本比较：v1.3.8 / 1.3.8 / 1.3.8-rc1 等，仅比较数字段。 */
function semverGt(a, b) {
  const norm = (s) => String(s || '').replace(/^v/, '').split(/[.\-]/).map((p) => Number(p) || 0);
  const x = norm(a), y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const xi = x[i] || 0, yi = y[i] || 0;
    if (xi !== yi) return xi > yi;
  }
  return false;
}

export function apply(ctx) {
  const disposers = [];

  // 每次加载 / 重载插件时清空上一次残留的模型健康（失败计数 + 熔断冷却）。
  // 健康表是进程级单例缓存：旧版本（多模态硬过滤）可能把一批本来可用的成员
  // 反复判失败、推进熔断，重载后如果沿用旧状态，刚修好的成员仍会被跳过。
  // 清零是安全的——真正的上游不可用仍由 FAILOVER 与看板实时探测照常兜底。
  try { groupHealth.reset(); } catch { /* 忽略 */ }

  // 同步清空 dock 徽标状态：重载后没有"当前模型"可报，徽标回落为不显示，
  // 直到模型组下一次真正产出正文才重新点亮。
  try {
    dockGroupState.sessionId = null;
    dockGroupState.memberId = '';
    dockGroupState.memberName = '';
    dockGroupState.switchFrom = '';
    dockGroupState.switchAt = 0;
    dockGroupState.switchCount = 0;
    dockGroupState.updatedAt = 0;
  } catch { /* 忽略 */ }

  // 从磁盘读回调用日志快照（重载/重启不丢）。fire-and-forget：hydrate 内部已
  // 全量 try/catch，失败静默；不阻塞插件激活。
  try { Promise.resolve(groupUsage.hydrate()).catch(() => {}); } catch { /* 忽略 */ }

  // Slash-command handlers run against an agent invocation ({ agent, rawInput }),
  // NOT the plugin context — so both handlers close over the plugin ctx instead.
  disposers.push(ctx.commands.register({
    name: 'nvidia-models-detect',
    title: '检测 NVIDIA 可用模型',
    description: '实时查询 NVIDIA NIM API，列出当前可用模型及简介',
    handler: async () => {
      const result = await detectNvidiaModels();
      const head = result.source === 'live'
        ? '实时检测到 ' + result.count + ' 个可用模型（来自 NVIDIA API）：'
        : 'NVIDIA API 不可达（' + result.reason + '），以下为内置目录：';
      const list = result.models.map((m) => '- ' + m.name + ' (' + m.id + ')：' + m.description).join('\n');
      return { kind: 'success', text: head + '\n\n' + list + '\n\n运行 /nvidia-models-configure 可将模型写入 llm-pi-ai 的 nvidia 供应商。' };
    },
  }));

  disposers.push(ctx.commands.register({
    name: 'nvidia-models-configure',
    title: '配置 NVIDIA 模型到设置',
    description: '把检测到的模型批量写入 llm-pi-ai 的 nvidia 供应商模型列表',
    handler: async () => {
      const result = await configureNvidiaModels(ctx);
      return result.ok
        ? { kind: 'success', text: result.message }
        : { kind: 'error', text: result.error };
    },
  }));

  // Install the credential-resolver closure: stored key first (it outranks the
  // environment by design), then the plain environment variable.
  resolveKeyFromContext = async () => {
    try {
      const resolved = await new Promise((done) => {
        ctx.inject(['credentials'], (scoped) => {
          try {
            done((async () => {
              const credentials = scoped.credentials;
              try {
                const hit = await credentials.resolve('ONE_BALANCE_API_KEY');
                if (hit && typeof hit.value === 'string' && hit.value.trim()) return hit.value.trim();
              } catch {
                // The reference form may be rejected; fall through to env.
              }
              return '';
            })());
          } catch {
            done();
          }
        });
      });
      if (resolved) return resolved;
    } catch {
      // Credential seam unavailable; env fallback below.
    }
    const fromEnv = process.env.ONE_BALANCE_API_KEY;
    return fromEnv && fromEnv.trim() ? fromEnv.trim() : '';
  };

  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.connection;
    const unregisterRoute = connection.fetch.register(createNvidiaModelsRoute(ctx), 'nvidia-models: /api/nvidia-models route');
    scoped.effect(() => unregisterRoute, 'nvidia-models: /api route');
  });

  // 注册「NVIDIA 模型组」LLM 适配器（provider = nvidia-group）。
  // 用可选注入：没有 llm 服务时插件其余功能照常可用，仅模型组不可用。
  ctx.inject(['llm'], (scoped) => {
    try {
      const llm = scoped.llm;
      const adapter = buildGroupAdapter(ctx, llm);
      // registerAdapter 自身以 ctx.effect 挂载，随 fiber 释放，无需手动注销。
      llm.registerAdapter(['nvidia-group'], adapter);
    } catch (error) {
      // 适配器注册失败不应拖垮插件；面板会显示模型组不可用。
      try { console.warn('[nvidia-models-panel] 注册 nvidia-group 适配器失败：' + describeErrorSafe(error)); } catch { /* 忽略 */ }
    }
  });

  // 注册会话投影 nvidiaHealth：把故障转移/探测事件折成看板状态。
  ctx.inject(['sessionProjections'], (scoped) => {
    try {
      const registry = scoped.sessionProjections;
      // register() 是 thenable，且内部以 ctx.effect 挂载（随 fiber 释放）。
      Promise.resolve(registry.register({
        key: 'nvidiaHealth',
        stateVersion: 1,
        stateSchema: makeSchema(),
        init: () => createGroupState(),
        apply: (state, event) => foldGroupEvent(state, event),
        wire: {
          viewSchema: makeSchema(),
          view: (state) => state,
          summary: false,
        },
      })).catch((error) => {
        try { console.warn('[nvidia-models-panel] 注册 nvidiaHealth 投影失败：' + describeErrorSafe(error)); } catch { /* 忽略 */ }
      });
    } catch (error) {
      try { console.warn('[nvidia-models-panel] 注册 nvidiaHealth 投影失败：' + describeErrorSafe(error)); } catch { /* 忽略 */ }
    }
  });

  // 自动发现守护：周期性静默拉取 NVIDIA 模型目录，刷新 lastDetectedModels，
  // 让「NVIDIA 模型组」自动跟上新上架/下架的模型，无需用户手动点「检测」。
  // 仅在已有 API Key 时才探测；失败静默（不打扰用户），退避由定时器自然承担。
  const startAutoDiscovery = () => {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      try {
        const key = await resolveKeyFromContext();
        if (key) {
          const detection = await detectNvidiaModels();
          if (detection && detection.source === 'live') {
            lastDetectedModels = normalizeGroupMembers(detection.models);
          }
        }
      } catch {
        // 自动发现是尽力而为，失败静默。
      }
      if (stopped) return;
      const ms = Math.max(60000, Number(groupConfig.autoRefreshMs) || 300000);
      timer = setTimeout(tick, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    // 首次延迟 20s，避开启动高峰。
    timer = setTimeout(tick, 20000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  };
  disposers.push(startAutoDiscovery());

  return () => {
    resolveKeyFromContext = async () => '';
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose();
    }
  };
}
