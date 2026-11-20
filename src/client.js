window.__ModuleLoader__.load({
  id: 'dsh-nvidia-models-panel',
  factory(require) {
    const React = require('react');
    const { useState, useCallback, useRef, useEffect } = React;
    const h = React.createElement;

    const BUILTIN_MODELS = [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Llama 3.1 Nemotron 70B', description: 'NVIDIA flagship reasoning model for complex reasoning, coding, and math', contextLength: 128000 },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', description: 'Ultra-large model with strong reasoning and coding', contextLength: 1000000 },
      { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', description: 'Balanced high-performance model for enterprise tasks', contextLength: 262144 },
      { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B', description: 'Lightweight fast MoE model', contextLength: 262144 },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano Omni 30B', description: 'Omni-modal model supporting text and image', contextLength: 256000 },
      { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Llama 3.1 Nemotron Ultra 253B', description: 'NVIDIA-optimized Llama 3.1 253B model', contextLength: 128000 },
      { id: 'nvidia/cosmos-reason2-8b', name: 'Cosmos Reason2 8B', description: 'Physical-world reasoning model for robotics and video', contextLength: 131072 },
      { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: 'DeepSeek fast long-context model supporting text and image', contextLength: 1000000 },
      { id: 'moonshotai/kimi-k3', name: 'Kimi K3', description: 'Moonshot Kimi flagship model with 1M context window', contextLength: 1048576 },
      { id: 'z-ai/glm-5.3', name: 'GLM-5.3', description: 'Zhipu GLM flagship model with strong reasoning and long context', contextLength: 1000000 },
    ];

    const VERIFY_CONCURRENCY = 4;

    function NvidiaPanelIcon(props) {
      const active = !!(props && props.active);
      return h('button', {
        onClick: props && props.onClick,
        'aria-label': 'NVIDIA Models',
        title: 'NVIDIA Models',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          color: active ? '#76B900' : 'inherit',
        },
      }, h('svg', {
        viewBox: '0 0 24 24',
        width: 20,
        height: 20,
        fill: 'currentColor',
        'aria-hidden': 'true',
      }, h('path', { d: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' })));
    }

    /** Badge for one model's probe result. */
    function statusBadge(result) {
      if (!result) {
        return h('span', { style: { fontSize: '11px', opacity: 0.5, border: '1px solid rgba(128,128,128,0.35)', borderRadius: '4px', padding: '1px 6px' } }, 'Untested');
      }
      if (result.status === 'testing') {
        return h('span', { style: { fontSize: '11px', color: '#b8860b', border: '1px solid #b8860b', borderRadius: '4px', padding: '1px 6px' } }, 'Testing…');
      }
      if (result.status === 'ok') {
        return h('span', { style: { fontSize: '11px', color: '#2e7d32', border: '1px solid #2e7d32', borderRadius: '4px', padding: '1px 6px', background: 'rgba(46,125,50,0.10)' } }, 'Available ✓');
      }
      if (result.status === 'skip') {
        return h('span', { style: { fontSize: '11px', opacity: 0.6, border: '1px dashed rgba(128,128,128,0.5)', borderRadius: '4px', padding: '1px 6px' } }, 'Skipped');
      }
      return h('span', { style: { fontSize: '11px', color: '#c62828', border: '1px solid #c62828', borderRadius: '4px', padding: '1px 6px', background: 'rgba(198,40,40,0.08)' } }, 'Unavailable');
    }

    /** Badge for one group member's live health status. */
    function groupBadge(status) {
      const map = {
        ok: { c: '#2e7d32', t: 'Healthy ✓' },
        failed: { c: '#c62828', t: 'Failed' },
        unknown: { c: '#8a8a8a', t: 'Unknown' },
      };
      const s = map[status] || map.unknown;
      return h('span', {
        style: { fontSize: '11px', color: s.c, border: '1px solid ' + s.c, borderRadius: '4px', padding: '1px 6px' },
      }, s.t);
    }

    /**
     * 输入框 dock 徽标：显示模型组最近真正出正文的模型 + 切换/熔断计数。
     * 独立 React 树，自己轮询 /api/nvidia-models 的 dockStatus（3 秒一次）。
     * 未使用模型组时（active=false）完全不渲染，平时不打扰。
     */
    function DockBadge(props) {
      const [status, setStatus] = useState(null);
      const btnRef = useRef(null);

      // 运行时实测对齐：dock 槽位容器的真实宽度/缩进由宿主 CSS 决定，静态猜 CSS 变量不可靠。
      // 直接测量输入框 card 的实际右边缘，动态设置 marginRight 让徽标右边缘与它重合。
      useEffect(function () {
        if (!status || !status.active) return;
        var cancelled = false;
        function findCard(input) {
          var el = input;
          while (el && el !== document.body) {
            var r = el.getBoundingClientRect();
            var cs = window.getComputedStyle(el);
            if (r.width > 400 && r.width <= window.innerWidth - 16 &&
                parseFloat(cs.borderTopLeftRadius) >= 10) return el;
            el = el.parentElement;
          }
          return null;
        }
        function align() {
          if (cancelled) return;
          var btn = btnRef.current;
          var input = document.querySelector('[data-composer-input]');
          if (!btn || !input) return;
          var card = findCard(input);
          if (!card) return;
          // btn.right = 容器右缘 - marginRight。要让 btn.right 追上 card.right（增量 = card.right - btn.right），
          // 需把 marginRight 减去同样的增量（marginRight 越大按钮越靠左）。
          var delta = card.getBoundingClientRect().right - btn.getBoundingClientRect().right;
          if (Math.abs(delta) >= 1) {
            var cur = parseFloat(window.getComputedStyle(btn).marginRight) || 0;
            btn.style.marginRight = (cur - delta) + 'px';
          }
        }
        var n = 0;
        var raf;
        function converge() { align(); if (++n < 10) raf = requestAnimationFrame(converge); }
        converge();
        var timer = setInterval(align, 2000);
        return function () { cancelled = true; cancelAnimationFrame(raf); clearInterval(timer); };
      }, [status && status.active]);

      const sessionId = props && props.sessionId;
      const refresh = useCallback(async function () {
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'dockStatus', sessionId: sessionId || undefined }),
          });
          if (!response.ok) return;
          const data = await response.json();
          if (data && data.ok) setStatus(data);
        } catch {
          // best-effort
        }
      }, [sessionId]);

      useEffect(function () {
        refresh();
        const id = setInterval(refresh, 3000);
        return function () { clearInterval(id); };
      }, [refresh]);

      if (!status || !status.active) return null;

      const name = status.memberName || status.memberId || 'Group';
      const justSwitched = Boolean(status.switchFrom);
      const label = justSwitched
        ? ('⚡ ' + name + ' ← from ' + status.switchFrom + ' · ' + status.switchCount + ' switches')
        : ('⚡ ' + name + ' · ' + status.switchCount + ' switches · ' + status.cooldownCount + ' cooling');

      const openUsage = function () {
        try {
          window.dispatchEvent(new CustomEvent('nvidia-models-open-usage'));
        } catch { /* 忽略：面板可能未挂载 */ }
      };

      // dock 容器（._7yHdaG_dock）相对输入框两边各缩进了 2×--dsh-composer-dock-inset：
      //   max-width = card-max - 2×inset，padding = 0 inset，margin 0 auto
      // 所以 dock 内容区右边缘比输入框右边缘靠左 2×inset（默认 16px）。
      // 用 flex-end 靠右后，再给徽标一个负 margin-right = -2×inset 抵消这段缩进，
      // 右边缘就与输入框右边缘像素级对齐。不用 absolute（外层空 div 高度会塌缩成 0）。
      return h('div', {
        style: {
          display: 'flex',
          justifyContent: 'flex-end',
          width: '100%',
          boxSizing: 'border-box',
        },
      }, h('button', {
        ref: btnRef,
        type: 'button',
        onClick: openUsage,
        title: 'View NVIDIA Group usage log',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '11px',
          lineHeight: '1.2',
          color: justSwitched ? '#e65100' : '#8fce00',
          border: '1px solid ' + (justSwitched ? 'rgba(230,81,0,0.55)' : 'rgba(143,206,0,0.5)'),
          background: justSwitched ? 'rgba(230,81,0,0.10)' : 'rgba(143,206,0,0.08)',
          borderRadius: '999px',
          padding: '2px 10px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          maxWidth: '420px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          height: '32px',
          boxSizing: 'border-box',
          flexShrink: 0,
          marginRight: 'calc(-2 * var(--dsh-composer-dock-inset, 8px))',
        },
      }, label));
    }

    /** 黄色警示条：未配置 Key 时在关键位置提示用户先去保存 Key。 */
    function noKeyWarning(message) {
      return h('div', {
        style: {
          padding: '8px 10px',
          background: 'rgba(230,150,0,0.12)',
          border: '1px solid rgba(230,150,0,0.55)',
          borderRadius: '6px',
          fontSize: '12px',
          lineHeight: 1.5,
          color: '#b8860b',
        },
      }, message);
    }

    function NvidiaModelsPanel(props) {
      const [models, setModels] = useState([]);
      const [detecting, setDetecting] = useState(false);
      const [verifying, setVerifying] = useState(false);
      const [message, setMessage] = useState('');
      const [results, setResults] = useState({});
      const [tab, setTab] = useState('models');
      const cancelRef = useRef(false);

      const onClose = props && props.onClose;

      // ---- API key management ----
      const [keyInput, setKeyInput] = useState('');
      const [keyStatus, setKeyStatus] = useState(null);
      const [keyBusy, setKeyBusy] = useState(false);
      const [keyMsg, setKeyMsg] = useState('');

      const refreshKeyStatus = useCallback(async function () {
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'keyStatus' }),
          });
          if (!response.ok) return;
          const data = await response.json();
          setKeyStatus(data);
        } catch {
          // Status check is best-effort; the panel still works without it.
        }
      }, []);

      useEffect(function () { refreshKeyStatus(); }, [refreshKeyStatus]);

      const saveKey = useCallback(async function () {
        const key = keyInput.trim();
        if (!key) { setKeyMsg('Please enter an API Key first'); return; }
        setKeyBusy(true);
        setKeyMsg('Saving…');
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'setKey', key }),
          });
          const data = await response.json();
          if (data && data.saved) {
            setKeyInput('');
            setKeyMsg('Saved to credential store (not written to config files). Active on next request; you can now run Verify All.');
            await refreshKeyStatus();
          } else {
            setKeyMsg('Save failed: ' + ((data && data.error) || ('HTTP ' + response.status)));
          }
        } catch (error) {
          setKeyMsg('Save request failed: ' + String((error && error.message) || error));
        } finally {
          setKeyBusy(false);
        }
      }, [keyInput, refreshKeyStatus]);

      const clearKey = useCallback(async function () {
        setKeyBusy(true);
        setKeyMsg('Clearing…');
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'clearKey' }),
          });
          const data = await response.json();
          if (data && data.cleared) {
            setKeyMsg('Cleared stored key (ONE_BALANCE_API_KEY env var will be used if set).');
            await refreshKeyStatus();
          } else {
            setKeyMsg('Clear failed: ' + ((data && data.error) || ('HTTP ' + response.status)));
          }
        } catch (error) {
          setKeyMsg('Clear request failed: ' + String((error && error.message) || error));
        } finally {
          setKeyBusy(false);
        }
      }, [refreshKeyStatus]);

      const setOne = useCallback(function (id, patch) {
        setResults(function (prev) {
          const next = { ...prev };
          next[id] = { ...(prev[id] || {}), ...patch };
          return next;
        });
      }, []);

      const detectModels = useCallback(async function () {
        setDetecting(true);
        setMessage('Querying NVIDIA API…');
        setResults({});
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'detect' }),
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          if (data && data.source === 'live' && Array.isArray(data.models)) {
            setModels(data.models);
            setMessage('Detected ' + data.count + ' models live from NVIDIA API. Click "Verify All" to test availability via One-Balance.');
          } else {
            setModels((data && data.models) || BUILTIN_MODELS);
            setMessage((data && data.reason ? data.reason + '; ' : '') + 'showing built-in catalog.');
          }
        } catch (error) {
          setModels(BUILTIN_MODELS);
          setMessage('Detection failed: ' + String((error && error.message) || error) + '; showing built-in catalog.');
        } finally {
          setDetecting(false);
        }
      }, []);

      /** Probe every listed model (shared by the verify button and configure). */
      const runVerification = useCallback(async function (list) {
        setVerifying(true);
        cancelRef.current = false;
        const queue = list.map(function (m) { return m.id; });
        const finalResults = {};
        let done = 0;
        const total = list.length;
        setResults({});
        for (const id of queue) { finalResults[id] = { status: 'testing' }; setOne(id, { status: 'testing' }); }
        setMessage('Verifying models (concurrency ' + VERIFY_CONCURRENCY + ', first-byte stream check)… 0/' + total);

        async function worker() {
          for (;;) {
            if (cancelRef.current) return;
            const id = queue.shift();
            if (!id) return;
            let outcome;
            try {
              const response = await fetch('/api/nvidia-models', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'test', model: id }),
              });
              if (!response.ok) {
                outcome = { status: 'fail', detail: 'Probe failed (HTTP ' + response.status + ')' };
              } else {
                const data = await response.json();
                outcome = { status: data.status, detail: data.detail };
              }
            } catch (error) {
              outcome = { status: 'fail', detail: 'Probe error: ' + String((error && error.message) || error) };
            }
            finalResults[id] = outcome;
            setOne(id, outcome);
            done += 1;
            setMessage('Verifying… ' + done + '/' + total);
          }
        }

        const workers = [];
        for (let i = 0; i < VERIFY_CONCURRENCY; i += 1) workers.push(worker());
        await Promise.all(workers);
        setVerifying(false);
        return finalResults;
      }, [setOne]);

      const verifyAll = useCallback(async function () {
        if (verifying || models.length === 0) return;
        const finalResults = await runVerification(models);
        const done = Object.keys(finalResults).length;
        if (cancelRef.current) {
          setMessage('Verification stopped (' + done + '/' + models.length + ' completed).');
          return;
        }
        const okCount = Object.values(finalResults).filter(function (r) { return r && r.status === 'ok'; }).length;
        setMessage('Verification complete: ' + okCount + '/' + done + ' models available. Click "One-Click Configure" to save them.');
      }, [models, verifying, runVerification]);

      const [configuring, setConfiguring] = useState(false);

      /** One click: probe (if not yet done) then write ONLY the available models. */
      const configureModels = useCallback(async function () {
        if (configuring) return;
        if (models.length === 0) {
          setMessage('Click "Detect Models" first to fetch the model list.');
          return;
        }
        setConfiguring(true);
        const tested = Object.keys(results).filter(function (id) {
          return results[id] && results[id].status !== 'testing';
        }).length;
        let finalResults = results;
        if (tested < models.length) {
          setMessage('Verification incomplete — verifying models before saving…');
          finalResults = await runVerification(models);
          if (cancelRef.current) {
            setMessage('Verification stopped; configuration aborted.');
            setConfiguring(false);
            return;
          }
        }
        const probePayload = {};
        for (const id of Object.keys(finalResults)) {
          probePayload[id] = finalResults[id] && finalResults[id].status === 'ok' ? 'ok' : 'unavailable';
        }
        const okCount = Object.values(finalResults).filter(function (r) { return r && r.status === 'ok'; }).length;
        setMessage('Writing ' + okCount + ' available models to settings…');
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'configure', results: probePayload }),
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          if (data && data.ok) {
            setMessage(data.message || 'Saved to settings.');
            // 配置会改写 nvidia 供应商的模型列表，也即模型组的成员来源；
            // 立即刷新健康看板并切到「模型组健康」页，让用户马上看到新成员。
            try { await refreshGroup(); } catch { /* best-effort */ }
            setTab('group');
          } else {
            setMessage('Configuration failed: ' + ((data && data.error) || 'Unknown error'));
          }
        } catch (error) {
          setMessage('Configuration request failed: ' + String((error && error.message) || error));
        } finally {
          setConfiguring(false);
        }
      }, [configuring, models, results, runVerification]);

      const stopVerify = useCallback(function () {
        cancelRef.current = true;
      }, []);

      // ---- model group health dashboard ----
      const [group, setGroup] = useState(null);
      const [groupBusy, setGroupBusy] = useState(false);
      const [groupMsg, setGroupMsg] = useState('');

      const refreshGroup = useCallback(async function () {
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'groupStatus' }),
          });
          if (!response.ok) return;
          const data = await response.json();
          if (data && data.ok) setGroup(data);
        } catch {
          // best-effort
        }
      }, []);

      useEffect(function () { refreshGroup(); }, [refreshGroup]);

      const probeGroupNow = useCallback(async function () {
        if (groupBusy) return;
        setGroupBusy(true);
        setGroupMsg('Probing all group members (first-byte check)…');
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'probeGroup' }),
          });
          const data = await response.json();
          const okCount = (data && data.results) ? data.results.filter(function (r) { return r && r.status === 'ok'; }).length : 0;
          setGroupMsg('Probe complete: ' + okCount + '/' + (data.probed || 0) + ' members available.');
          await refreshGroup();
        } catch (error) {
          setGroupMsg('Probe request failed: ' + String((error && error.message) || error));
        } finally {
          setGroupBusy(false);
        }
      }, [groupBusy, refreshGroup]);

      const resetGroupHealth = useCallback(async function (model) {
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'resetGroup', model: model || '' }),
          });
          const data = await response.json();
          if (data && data.ok) setGroup(data);
          setGroupMsg(model ? ('Reset circuit breaker for ' + model + '.') : 'Reset all member cooldowns.');
        } catch (error) {
          setGroupMsg('Reset failed: ' + String((error && error.message) || error));
        }
      }, []);

      const groupCard = h('div', {
        key: 'group',
        style: {
          padding: '12px',
          background: 'rgba(118,185,0,0.06)',
          border: '1px solid rgba(118,185,0,0.35)',
          borderRadius: '6px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, 'Group Health (Auto-Failover)'),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', {
              onClick: probeGroupNow,
              disabled: groupBusy,
              style: { padding: '5px 10px', fontSize: '12px', background: '#76B900', color: '#fff', border: 'none', borderRadius: '5px', cursor: groupBusy ? 'wait' : 'pointer', opacity: groupBusy ? 0.6 : 1 },
            }, groupBusy ? 'Probing…' : 'Probe Group'),
            h('button', {
              onClick: refreshGroup,
              style: { padding: '5px 10px', fontSize: '12px', background: 'transparent', border: '1px solid rgba(128,128,128,0.4)', color: 'inherit', borderRadius: '5px', cursor: 'pointer' },
            }, 'Refresh')
          )
        ),
        h('p', { style: { margin: 0, fontSize: '11px', opacity: 0.7, lineHeight: 1.5 } },
          'When "NVIDIA Group (Auto)" is selected, requests try members in health order and fail over if the first byte exceeds ' +
          ((group && group.config && group.config.firstByteTimeoutMs ? Math.round(group.config.firstByteTimeoutMs / 1000) : 30)) +
          's; repeated failures trigger exponential cooldown.'),
        groupMsg ? h('p', { style: { margin: 0, fontSize: '12px', lineHeight: 1.5 } }, groupMsg) : null,
        (group && Array.isArray(group.members) && group.members.length > 0)
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              group.members.map(function (m) {
                const cooling = m.cooldownRemainingMs > 0;
                return h('div', {
                  key: m.id,
                  style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '6px 8px', background: 'rgba(128,128,128,0.06)', border: '1px solid rgba(128,128,128,0.2)', borderRadius: '5px' },
                },
                  h('span', { style: { fontWeight: 600, fontSize: '12px' } }, m.name || m.id),
                  groupBadge(m.status),
                  cooling ? h('span', { style: { fontSize: '11px', color: '#b8860b' } }, 'Cooling · ' + Math.ceil(m.cooldownRemainingMs / 1000) + 's left') : null,
                  m.lastFirstByteMs !== null && m.lastFirstByteMs !== undefined ? h('span', { style: { fontSize: '11px', opacity: 0.65 } }, 'TTFB ' + m.lastFirstByteMs + 'ms') : null,
                  m.failCount > 0 ? h('span', { style: { fontSize: '11px', opacity: 0.65 } }, 'Failures: ' + m.failCount) : null,
                  (cooling || m.failCount > 0) ? h('button', {
                    onClick: function () { resetGroupHealth(m.id); },
                    style: { marginLeft: 'auto', padding: '3px 8px', fontSize: '11px', background: 'transparent', border: '1px solid rgba(128,128,128,0.4)', color: 'inherit', borderRadius: '4px', cursor: 'pointer' },
                  }, 'Reset') : null,
                  m.lastError ? h('span', { style: { fontSize: '11px', color: '#c62828', flexBasis: '100%' } }, String(m.lastError).slice(0, 160)) : null
                );
              })
            )
          : h('p', { style: { margin: 0, fontSize: '12px', opacity: 0.6 } },
              'No models in group yet: run Detect Models → Verify All → One-Click Configure first.'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '2px' } },
          h('span', { style: { fontSize: '11px', opacity: 0.7, alignSelf: 'center' } }, 'Select "NVIDIA Group (Auto)" in the chat model picker for automatic routing & failover.'),
          h('button', {
            onClick: function () { resetGroupHealth(''); },
            style: { padding: '3px 8px', fontSize: '11px', background: 'transparent', border: '1px solid rgba(128,128,128,0.4)', color: 'inherit', borderRadius: '4px', cursor: 'pointer' },
          }, 'Reset All Cooldowns')
        )
      );

      // ---- daily usage log (调用日志) ----
      const [usage, setUsage] = useState(null);
      const [usageBusy, setUsageBusy] = useState(false);
      const [usageMsg, setUsageMsg] = useState('');
      // 「?」使用说明弹窗开关（方案 A：标题栏入口 + 居中浮层）
      const [helpOpen, setHelpOpen] = useState(false);
      // ---- 新版本检测 ----
      const [updateInfo, setUpdateInfo] = useState(null);
      const [updateBusy, setUpdateBusy] = useState(false);

      const refreshUsage = useCallback(async function () {
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'usageStats' }),
          });
          if (!response.ok) return;
          const data = await response.json();
          if (data && data.ok) setUsage(data.stats);
        } catch {
          // best-effort
        }
      }, []);

      const refreshUpdateCheck = useCallback(async function () {
        if (updateBusy) return;
        setUpdateBusy(true);
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'checkUpdate' }),
          });
          if (!response.ok) return;
          const data = await response.json();
          if (data && data.ok) setUpdateInfo(data);
        } catch {
          // best-effort
        } finally {
          setUpdateBusy(false);
        }
      }, []);

      // Check once on mount.
      useEffect(function () { refreshUpdateCheck(); }, [refreshUpdateCheck]);

      // 输入框 dock 徽标点击后，切到「调用日志」标签页。
      useEffect(function () {
        function onOpenUsage() { setTab('usage'); }
        try {
          window.addEventListener('nvidia-models-open-usage', onOpenUsage);
          return function () { window.removeEventListener('nvidia-models-open-usage', onOpenUsage); };
        } catch {
          return undefined;
        }
      }, []);

      // Refresh when the user switches to the usage tab.
      useEffect(function () {
        if (tab === 'usage') refreshUsage();
      }, [tab, refreshUsage]);

      const resetUsageToday = useCallback(async function () {
        if (usageBusy) return;
        setUsageBusy(true);
        try {
          const response = await fetch('/api/nvidia-models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'resetUsage' }),
          });
          const data = await response.json();
          if (data && data.ok) setUsage(data.stats);
          setUsageMsg('Cleared today\'s usage stats.');
        } catch (error) {
          setUsageMsg('Clear failed: ' + String((error && error.message) || error));
        } finally {
          setUsageBusy(false);
        }
      }, [usageBusy]);

      const fmtTokens = function (n) {
        const v = Number(n) || 0;
        if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
        if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
        return String(v);
      };
      const fmtTime = function (ts) {
        if (!ts) return '';
        try {
          const d = new Date(ts);
          const p = function (x) { return String(x).padStart(2, '0'); };
          return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        } catch { return ''; }
      };
      const statBox = function (label, value, color) {
        return h('div', {
          key: 'stat-' + label,
          style: { flex: '1 1 0', minWidth: '74px', padding: '8px', background: 'rgba(128,128,128,0.08)', border: '1px solid rgba(128,128,128,0.2)', borderRadius: '5px', display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center' },
        },
          h('span', { style: { fontSize: '10px', opacity: 0.65 } }, label),
          h('span', { style: { fontSize: '15px', fontWeight: 600, color: color || 'inherit' } }, value)
        );
      };

      const usageTotal = (usage && usage.total) || { calls: 0, ok: 0, fail: 0, failovers: 0, inputTokens: 0, outputTokens: 0 };
      const usageMembers = (usage && Array.isArray(usage.members)) ? usage.members : [];
      const usageLog = (usage && Array.isArray(usage.log)) ? usage.log : [];

      const usageCard = h('div', {
        key: 'usage',
        style: { padding: '12px', background: 'rgba(118,185,0,0.06)', border: '1px solid rgba(118,185,0,0.35)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '10px' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, 'Daily Group Usage Log' + (usage && usage.day ? ' (' + usage.day + ')' : '')),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', {
              onClick: refreshUsage,
              style: { padding: '5px 10px', fontSize: '12px', background: '#76B900', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer' },
            }, 'Refresh'),
            h('button', {
              onClick: resetUsageToday,
              disabled: usageBusy,
              style: { padding: '5px 10px', fontSize: '12px', background: 'transparent', border: '1px solid rgba(128,128,128,0.4)', color: 'inherit', borderRadius: '5px', cursor: usageBusy ? 'wait' : 'pointer' },
            }, 'Clear Today')
          )
        ),
        usageMsg ? h('p', { style: { margin: 0, fontSize: '12px', lineHeight: 1.5 } }, usageMsg) : null,
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          statBox('Total Calls', String(usageTotal.calls)),
          statBox('Success', String(usageTotal.ok), '#2e7d32'),
          statBox('Failed', String(usageTotal.fail), usageTotal.fail ? '#c62828' : 'inherit'),
          statBox('Failovers', String(usageTotal.failovers), usageTotal.failovers ? '#b8860b' : 'inherit'),
          statBox('Input Tokens', fmtTokens(usageTotal.inputTokens)),
          statBox('Output Tokens', fmtTokens(usageTotal.outputTokens))
        ),
        usageMembers.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              usageMembers.map(function (m) {
                return h('div', {
                  key: 'um-' + m.id,
                  style: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '6px 8px', background: 'rgba(128,128,128,0.06)', border: '1px solid rgba(128,128,128,0.18)', borderRadius: '4px' },
                },
                  h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline' } },
                    h('span', { style: { flex: '1 1 auto', fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(m.id).replace(/^custom-nvidia\//, '').replace(/^nvidia\//, '')),
                    m.failovers ? h('span', { style: { fontSize: '11px', color: '#b8860b', flex: '0 0 auto' } }, 'Failovers: ' + m.failovers) : h('span', { style: { fontSize: '11px', opacity: 0.6, flex: '0 0 auto' } }, 'Calls: ' + m.calls)
                  ),
                  h('div', { style: { display: 'flex', gap: '10px', fontSize: '11px', flexWrap: 'wrap', opacity: 0.85 } },
                    h('span', { style: { color: '#2e7d32' } }, '✓ ' + m.ok),
                    m.fail ? h('span', { style: { color: '#c62828' } }, '✗ ' + m.fail) : null,
                    h('span', null, 'Avg TTFB ' + (m.avgFirstByteMs ? m.avgFirstByteMs + 'ms' : '—')),
                    h('span', null, 'token ' + fmtTokens(m.inputTokens + m.outputTokens))
                  )
                );
              })
            )
          : h('p', { style: { margin: 0, fontSize: '12px', opacity: 0.6 } }, 'No calls recorded today. Select "NVIDIA Group (Auto)" in chat to start tracking.'),
        usageLog.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '260px', overflow: 'auto' } },
              h('div', { style: { fontSize: '11px', opacity: 0.6, padding: '0 6px' } }, 'Recent calls (newest first, up to 200)'),
              usageLog.map(function (e, i) {
                return h('div', {
                  key: 'ul-' + i,
                  style: { display: 'flex', fontSize: '11px', gap: '8px', padding: '4px 6px', background: 'rgba(128,128,128,0.05)', borderLeft: '3px solid ' + (e.ok ? '#76B900' : '#c62828'), alignItems: 'center', flexWrap: 'wrap' },
                },
                  h('span', { style: { flex: '0 0 58px', opacity: 0.6 } }, fmtTime(e.at)),
                  h('span', { style: { fontWeight: 600 } }, e.ok ? '✓' : '✗'),
                  h('span', { style: { flex: '1 1 120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(e.memberId).replace(/^custom-nvidia\//, '').replace(/^nvidia\//, '')),
                  e.failover ? h('span', { style: { fontSize: '10px', color: '#b8860b' } }, '← from ' + String(e.failoverFrom || '').replace(/^custom-nvidia\//, '').replace(/^nvidia\//, '')) : null,
                  e.ok ? h('span', { style: { opacity: 0.7 } }, 'TTFB ' + (e.firstByteMs || 0) + 'ms') : null,
                  (e.inputTokens || e.outputTokens) ? h('span', { style: { opacity: 0.7 } }, 'tok ' + fmtTokens(e.inputTokens) + '/' + fmtTokens(e.outputTokens)) : null,
                  e.error ? h('span', { style: { flexBasis: '100%', color: '#c62828', fontSize: '10px' } }, String(e.error).slice(0, 140)) : null
                );
              })
            )
          : null
      );

      // Tab bar — keeps actions + list on the "模型库" tab, the health
      // dashboard on its own tab, and the daily usage log on a third, so the
      // primary buttons are never pushed off the bottom of the panel.
      const tabButton = function (id, label) {
        const active = tab === id;
        return h('button', {
          key: id,
          onClick: function () { setTab(id); },
          style: {
            padding: '7px 14px',
            fontSize: '13px',
            fontWeight: active ? 600 : 500,
            background: 'transparent',
            color: 'inherit',
            border: 'none',
            borderBottom: active ? '2px solid #76B900' : '2px solid transparent',
            cursor: 'pointer',
            opacity: active ? 1 : 0.62,
            marginBottom: '-1px',
          },
        }, label);
      };
      const tabBar = h('div', {
        key: 'tabs',
        style: { display: 'flex', gap: '2px', borderBottom: '1px solid rgba(128,128,128,0.3)' },
      }, [tabButton('models', 'Models'), tabButton('group', 'Group Health'), tabButton('usage', 'Usage Log')]);

      // ---- 使用说明（方案 A：标题栏「?」→ 居中浮层）----
      const helpRow = function (label, text) {
        return h('div', { style: { display: 'flex', gap: '8px', fontSize: '12px', lineHeight: 1.55 } },
          h('span', { style: { flex: '0 0 66px', fontWeight: 600, color: '#8fce00' } }, label),
          h('span', { style: { flex: '1 1 auto', opacity: 0.9 } }, text)
        );
      };
      const helpStep = function (n, title, text) {
        return h('div', { key: 'help-step-' + n, style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } },
          h('span', {
            style: { flex: '0 0 20px', height: '20px', borderRadius: '50%', background: '#76B900', color: '#fff', fontSize: '12px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px' },
          }, String(n)),
          h('span', { style: { flex: '1 1 auto', fontSize: '12.5px', lineHeight: 1.55 } },
            h('b', { style: { color: 'inherit' } }, title), '：', text)
        );
      };
      const helpModal = !helpOpen ? null : h('div', {
        key: 'help-overlay',
        onClick: function (e) { if (e.target === e.currentTarget) setHelpOpen(false); },
        style: {
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          padding: '24px 12px', overflow: 'auto',
        },
      },
        h('div', {
          role: 'dialog',
          'aria-label': 'Help',
          style: {
            width: '100%', maxWidth: '348px',
            background: 'var(--dsh-surface, #1b1d20)',
            color: 'inherit',
            border: '1px solid rgba(128,128,128,0.35)',
            borderRadius: '10px',
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
            padding: '16px',
            display: 'flex', flexDirection: 'column', gap: '12px',
            flex: '0 0 auto',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontSize: '15px', fontWeight: 700 } }, 'Help'),
            h('button', {
              onClick: function () { setHelpOpen(false); },
              'aria-label': 'Close help',
              style: { background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', padding: '2px' },
            }, h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'currentColor', 'aria-hidden': 'true' },
              h('path', { d: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' })))
          ),
          keyStatus && !keyStatus.configured
            ? h('div', { style: { fontSize: '12px', color: '#b8860b', border: '1px solid rgba(184,134,11,0.5)', background: 'rgba(184,134,11,0.08)', borderRadius: '6px', padding: '7px 10px', lineHeight: 1.5 } },
                'One-Balance API Key is not configured — paste and save it above before continuing.')
            : null,
          helpStep(1, 'Save Key', 'Paste your One-Balance AUTH_KEY and save; shared with the one-balance-nvidia route without writing to config files.'),
          helpStep(2, 'Detect → Verify → Configure', 'In Models, click Detect Models, then Verify All, then One-Click Configure; only verified models are written to llm-pi-ai.'),
          helpStep(3, 'Enable Auto-Failover', 'Pick "NVIDIA Group (Auto)" in the chat model selector to route by live health and auto-failover.'),
          helpStep(4, 'Monitor', 'Use Group Health for cooldowns/TTFB and Usage Log for daily calls, tokens, and failover history.'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '10px' } },
            h('span', { style: { fontSize: '12px', fontWeight: 700 } }, 'How It Works'),
            helpRow('Failover', 'Switches to the next member if TTFB exceeds 30s; stops switching once visible text has streamed.'),
            helpRow('Cooldown', 'Repeated failures trigger exponential backoff (20s up to 5m) before auto-recovery.'),
            helpRow('Vision', 'Image requests prioritize multimodal members (vision / vl / omni) with text models as fallback.'),
            helpRow('Discovery', 'Silently refreshes the NVIDIA model catalog every 5 minutes.'),
            helpRow('Tokens', 'Shows 0 if upstream omits usage metadata.')
          )
        )
      );

      // 未配置 Key：主操作按钮禁用、关键位置给出就地提示（凭据服务不可用时不做拦截）。
      const noKey = Boolean(keyStatus && !keyStatus.configured && !keyStatus.unavailable);
      const keyHint = 'One-Balance API Key is not configured — paste and save it above before continuing.';

      return h('div', {
        className: 'nvidia-models-panel',
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: '16px',
          boxSizing: 'border-box',
          background: 'transparent',
          color: 'inherit',
          overflow: 'auto',
          gap: '12px',
          position: 'relative',
        },
      },
        h('div', {
          key: 'header',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingBottom: '12px',
            borderBottom: '1px solid rgba(128,128,128,0.3)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('svg', {
              viewBox: '0 0 24 24',
              width: 22,
              height: 22,
              fill: '#76B900',
              'aria-hidden': 'true',
            }, h('path', { d: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' })),
            h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, 'NVIDIA Models'),
            (function () {
              const info = updateInfo;
              const hasUpdate = Boolean(info && info.hasUpdate);
              const failed = Boolean(info && info.reachable === false && !hasUpdate);
              const currentVersion = info && info.currentVersion ? String(info.currentVersion).replace(/^v/, '') : null;
              let label, color;
              if (hasUpdate) {
                label = 'Update ↑ ' + (info.latestTag || '');
                color = '230,170,0';
              } else if (currentVersion) {
                // 已知当前版本且无新版本：一律显示版本号；网络不可达时加 ⚠ 提示可点击重试
                label = 'v' + currentVersion + (failed ? ' ⚠' : '');
                color = failed ? '200,120,60' : '128,128,128';
              } else if (failed) {
                label = 'Check failed · Retry';
                color = '200,120,60';
              } else {
                label = updateBusy ? 'Checking…' : 'Check updates';
                color = '128,128,128';
              }
              return h('button', {
                onClick: function () {
                  if (hasUpdate) {
                    const url = info.latestUrl || 'https://github.com/akincansenol/dsh-nvidia-models-panel/releases/latest';
                    window.open(url, '_blank', 'noopener,noreferrer');
                  } else if (!updateBusy) {
                    refreshUpdateCheck();
                  }
                },
                disabled: updateBusy && !hasUpdate,
                title: hasUpdate ? (info.message || 'View update') : (currentVersion ? ('Current v' + currentVersion + (failed ? ' (check failed, click to retry)' : ', click to recheck')) : 'Check updates'),
                style: {
                  padding: '3px 9px',
                  fontSize: '11px',
                  lineHeight: 1.4,
                  color: 'rgb(' + color + ')',
                  background: 'rgba(' + color + ',0.12)',
                  border: '1px solid rgba(' + color + ',0.35)',
                  borderRadius: '999px',
                  cursor: (hasUpdate || !updateBusy) ? 'pointer' : 'default',
                  whiteSpace: 'nowrap',
                  opacity: (updateBusy && !hasUpdate) ? 0.6 : 1,
                },
              }, label);
            })()
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('button', {
              onClick: function () { setHelpOpen(true); },
              'aria-label': 'Help',
              title: 'Help',
              style: {
                background: 'transparent',
                border: '1px solid rgba(128,128,128,0.4)',
                borderRadius: '50%',
                width: '20px',
                height: '20px',
                cursor: 'pointer',
                color: 'inherit',
                fontSize: '12px',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: 0.8,
                padding: 0,
              },
            }, '?'),
            h('button', {
              onClick: onClose,
              'aria-label': 'Close panel',
              style: {
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                color: 'inherit',
                display: 'flex',
                alignItems: 'center',
              },
            }, h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'currentColor', 'aria-hidden': 'true' },
              h('path', { d: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' })))
          )
        ),
        h('div', {
          key: 'apikey',
          style: {
            padding: '12px',
            background: 'rgba(128,128,128,0.06)',
            border: '1px solid rgba(128,128,128,0.25)',
            borderRadius: '6px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, 'One-Balance API Key'),
            keyStatus ? (keyStatus.configured
              ? h('span', { style: { fontSize: '11px', color: '#2e7d32', border: '1px solid #2e7d32', borderRadius: '4px', padding: '1px 6px', background: 'rgba(46,125,50,0.10)' } },
                'Configured' + (keyStatus.source ? ' (' + keyStatus.source + ')' : ''))
              : h('span', { style: { fontSize: '11px', opacity: 0.6, border: '1px dashed rgba(128,128,128,0.5)', borderRadius: '4px', padding: '1px 6px' } }, 'Not configured')) : null,
            keyStatus && keyStatus.unavailable ? h('span', { style: { fontSize: '11px', color: '#b8860b' } }, ' (credentials service unavailable)') : null,
          ),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('input', {
              type: 'password',
              value: keyInput,
              onChange: function (e) { setKeyInput(e.target.value); },
              placeholder: 'Enter One-Balance API Key (masked)',
              autoComplete: 'off',
              style: {
                flex: 1,
                minWidth: '200px',
                padding: '7px 12px',
                fontSize: '13px',
                border: '1px solid rgba(128,128,128,0.4)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'inherit',
                boxSizing: 'border-box',
              },
            }),
            h('button', {
              onClick: saveKey,
              disabled: keyBusy || !keyInput.trim(),
              style: {
                padding: '7px 14px',
                fontSize: '13px',
                fontWeight: 500,
                background: '#76B900',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                cursor: (keyBusy || !keyInput.trim()) ? 'wait' : 'pointer',
                opacity: (keyBusy || !keyInput.trim()) ? 0.6 : 1,
              },
            }, 'Save Key'),
            keyStatus && keyStatus.configured && keyStatus.writable ? h('button', {
              onClick: clearKey,
              disabled: keyBusy,
              style: {
                padding: '7px 14px',
                fontSize: '13px',
                background: 'transparent',
                border: '1px solid rgba(198,40,40,0.7)',
                color: '#c62828',
                borderRadius: '6px',
                cursor: keyBusy ? 'wait' : 'pointer',
              },
            }, 'Clear') : null,
          ),
          h('p', { style: { margin: 0, fontSize: '11px', opacity: 0.65, lineHeight: 1.5 } },
            'Stored in Harness credentials under ONE_BALANCE_API_KEY (never written to config files or logs); active on next request.'),
          noKey ? h('p', { style: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: '#b8860b' } },
            '⚠ Key not configured: Verification and Group failover require saving your One-Balance API Key above.') : null,
          keyMsg ? h('p', { style: { margin: 0, fontSize: '12px', lineHeight: 1.5 } }, keyMsg) : null,
        ),
        noKey ? noKeyWarning(keyHint) : null,
        tabBar,
        tab === 'models' ? h('div', {
          key: 'modelsPane',
          style: { display: 'flex', flexDirection: 'column', gap: '12px' },
        },
        [
        h('div', {
          key: 'actions',
          style: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
        },
          h('button', {
            onClick: detectModels,
            disabled: detecting || verifying || noKey,
            title: noKey ? keyHint : undefined,
            style: {
              padding: '7px 14px',
              fontSize: '13px',
              fontWeight: 500,
              background: '#76B900',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: (detecting || verifying || noKey) ? 'not-allowed' : 'pointer',
              opacity: (detecting || verifying || noKey) ? 0.6 : 1,
            },
          }, detecting ? 'Detecting…' : 'Detect Models'),
          h('button', {
            onClick: verifyAll,
            disabled: detecting || verifying || models.length === 0 || noKey,
            title: noKey ? keyHint : undefined,
            style: {
              padding: '7px 14px',
              fontSize: '13px',
              fontWeight: 500,
              background: verifying ? 'rgba(118,185,0,0.4)' : '#3d8400',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: (detecting || verifying || models.length === 0 || noKey) ? 'not-allowed' : 'pointer',
              opacity: noKey ? 0.6 : 1,
            },
          }, verifying ? 'Verifying…' : 'Verify All'),
          verifying ? h('button', {
            onClick: stopVerify,
            style: {
              padding: '7px 14px',
              fontSize: '13px',
              background: 'transparent',
              color: 'inherit',
              border: '1px solid rgba(198,40,40,0.7)',
              color: '#c62828',
              borderRadius: '6px',
              cursor: 'pointer',
            },
          }, 'Stop') : null,
          h('button', {
            onClick: configureModels,
            disabled: configuring || detecting || verifying || noKey,
            title: noKey ? keyHint : undefined,
            style: {
              padding: '7px 14px',
              fontSize: '13px',
              background: 'transparent',
              color: 'inherit',
              border: '1px solid rgba(128,128,128,0.4)',
              borderRadius: '6px',
              cursor: (configuring || detecting || verifying || noKey) ? 'not-allowed' : 'pointer',
              opacity: (configuring || detecting || verifying || noKey) ? 0.6 : 1,
            },
          }, configuring ? 'Configuring…' : 'One-Click Configure')
        ),
        message ? h('div', {
          key: 'message',
          style: {
            padding: '10px 12px',
            background: 'rgba(118,185,0,0.12)',
            border: '1px solid rgba(118,185,0,0.5)',
            borderRadius: '6px',
            fontSize: '13px',
            lineHeight: 1.5,
          },
        }, message) : null,
        models.length > 0 ? h('div', {
          key: 'models',
          style: { display: 'flex', flexDirection: 'column', gap: '8px' },
        }, models.map(function (model) {
          const r = results[model.id];
          return h('div', {
            key: model.id,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '10px 12px',
              background: 'rgba(128,128,128,0.06)',
              border: '1px solid rgba(128,128,128,0.25)',
              borderRadius: '6px',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600, fontSize: '13px' } }, model.name),
              statusBadge(r),
              h('span', {
                style: { fontSize: '11px', opacity: 0.65, fontFamily: 'monospace' },
                title: model.id,
              }, model.id)
            ),
            h('p', { style: { margin: 0, fontSize: '12px', opacity: 0.85, lineHeight: 1.5 } }, model.description),
            r && r.detail && r.status !== 'ok' && r.status !== 'testing' ? h('p', {
              style: { margin: 0, fontSize: '11px', color: '#c62828', lineHeight: 1.4 },
            }, r.detail) : null
          );
        })) : h('div', {
          key: 'empty',
          style: {
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            opacity: 0.55,
            gap: '8px',
            minHeight: '160px',
          },
        },
          h('svg', { viewBox: '0 0 24 24', width: 48, height: 48, fill: 'currentColor', 'aria-hidden': 'true' },
            h('path', { d: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' })),
          h('p', { style: { margin: 0, fontSize: '14px' } }, 'No models detected yet'),
          h('p', { style: { margin: 0, fontSize: '12px' } }, 'Click "Detect Models" to fetch the catalog, then "Verify All" to test via One-Balance')
        )
        ]) : (tab === 'usage' ? h('div', {
          key: 'usagePane',
          style: { display: 'flex', flexDirection: 'column', gap: '12px' },
        }, usageCard) : h('div', {
          key: 'groupPane',
          style: { display: 'flex', flexDirection: 'column', gap: '12px' },
        }, groupCard)),
        helpModal
      );
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const panelId = 'nvidia-models';

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: panelId,
            order: 100,
            label: 'NVIDIA Models',
          }, NvidiaPanelIcon);
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: panelId,
          }, NvidiaModelsPanel);
        });

        // 对话输入框上方的 dock 徽标：order 10 位于待办(0)与队列(20)之间。
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'nvidia-group-status',
            order: 10,
            inject: function (sessionId) { return { sessionId: sessionId }; },
          }, DockBadge);
        });
      },
    };
  },
});
