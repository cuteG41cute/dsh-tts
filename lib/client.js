// dsh-tts — Client half.
//
// Three slots:
//   conversation.chat.assistant-actions  -> speaker button under each assistant reply
//   conversation.input.right             -> global auto-read toggle (two styles)
//   conversation.session.header.utilities -> 「朗读」chip with the settings panel
//
// Speech: text is chunked, each chunk is synthesized host-side via
// POST /dsh-tts/api (OpenAI-compatible /audio/speech), and chunks are played
// back-to-back with one prefetch in flight. Endpoint/key/model/voice live in
// localStorage on this machine only; the host never persists them.
window.__ModuleLoader__.load({
  id: 'dsh-tts',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');

    /* ----------------------------- 配置（宿主落盘，全窗口共享） -----------------------------
     * 分离窗口/新 WebView2 实例各有自己的 localStorage，之前配置存那里导致每个
     * 新窗口都「未配置」。现在宿主 ~/.dsh/tts-config.json 是唯一真源：
     * 启动时 get-config 拉一次，保存时 save-config 写回；localStorage 只当渲染缓存。 */
    const LS_KEY = 'dsh-tts-config-v1';
    const DEFAULTS = { endpoint: '', apiKey: '', model: 'tts-1', voice: 'alloy', speed: 1, format: 'mp3', auto: false, autoScope: 'tail' };
    let config = loadLocal();
    const listeners = new Set();
    function loadLocal() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        const saved = raw ? JSON.parse(raw) : {};
        return Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
      } catch { return Object.assign({}, DEFAULTS); }
    }
    function cacheLocal() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(config)); } catch { /* 隐私模式等：只活在本轮 */ }
    }
    function notify() { listeners.forEach((fn) => { try { fn(config); } catch { /* 忽略单个订阅者错误 */ } }); }
    function saveConfig(patch) {
      config = Object.assign({}, config, patch);
      cacheLocal();
      // 写回宿主（全窗口共享），fire-and-forget；失败时本窗口仍能用
      rpcConfig('save-config', { config }).catch(() => { });
      notify();
      return config;
    }
    function subscribe(fn) { listeners.add(fn); fn(config); return () => listeners.delete(fn); }
    // 启动拉取宿主持久配置：宿主有就用宿主的（localStorage 过期/为空都不影响）
    rpcConfig('get-config', {}).then((r) => {
      if (r && r.ok === true && r.config && typeof r.config === 'object') {
        config = Object.assign({}, DEFAULTS, r.config);
        cacheLocal();
        notify();
      }
    }).catch(() => { });

    function rpcConfig(method, args) {
      return fetch('/dsh-tts/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args: args || {} }),
      }).then((r) => r.json());
    }

    function rpc(text) {
      return fetch('/dsh-tts/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'speak',
          args: {
            text,
            endpoint: config.endpoint, apiKey: config.apiKey,
            model: config.model, voice: config.voice, speed: Number(config.speed) || 1, format: config.format,
          },
        }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, reason: String(e && e.message !== undefined ? e.message : e) }));
    }

    /* ----------------------------- 播放队列 -----------------------------
     * chunks 逐个合成（有一个 prefetch 在飞），逐个播放；同一时刻只有一段音频。
     * playing = { key, chunk, total } 或 null。key 由调用方给（消息正文哈希），
     * 用于「这条消息正在读」的高亮和防止自动朗读重复。 */
    const player = {
      audio: null, queue: [], key: '', label: '', chunk: 0, total: 0, busy: false,
      aborted: false, error: '', listeners: new Set(),
      emit() { const snap = this.snapshot(); this.listeners.forEach((fn) => { try { fn(snap); } catch { /* ignore */ } }); },
      snapshot() {
        return this.audio || this.queue.length || this.busy
          ? { playing: true, key: this.key, label: this.label, chunk: this.chunk, total: this.total, error: this.error }
          : { playing: false, key: '', label: '', chunk: 0, total: 0, error: this.error };
      },
      subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); },
      stop() {
        this.aborted = true; this.queue = []; this.busy = false; this.label = '';
        if (this.audio) { try { this.audio.pause(); } catch { /* ignore */ } this.audio = null; }
        this.emit();
      },
      /** text 分块后进队列；label = 这次朗读归属的会话名（芯片里显示用）。 */
      play(text, key, label) {
        const chunks = chunkText(text);
        if (!chunks.length) return '';
        this.stop();
        this.aborted = false; this.queue = chunks.slice(); this.key = key; this.label = label || ''; this.chunk = 0; this.total = chunks.length; this.error = '';
        this.emit();
        this.pump();
        return key;
      },
      async pump() {
        if (this.busy) return;
        this.busy = true;
        let prefetch = null;
        try {
          while (this.queue.length && !this.aborted) {
            const text = this.queue.shift();
            this.chunk = this.total - this.queue.length;
            this.emit();
            const job = prefetch || rpc(text);
            prefetch = this.queue.length && !this.aborted ? rpc(this.queue[0]) : null;
            const res = await job;
            if (this.aborted) break;
            if (!res || res.ok !== true) {
              this.error = (res && (res.reason || 'unknown')) || 'network-error';
              this.queue = [];
              this.emit();
              break;
            }
            await new Promise((resolve) => {
              const audio = new Audio('data:' + (res.mime || 'audio/mpeg') + ';base64,' + res.audio);
              this.audio = audio;
              const done = () => { if (this.audio === audio) this.audio = null; audio.onended = audio.onerror = null; resolve(); };
              audio.onended = done;
              audio.onerror = () => { this.error = 'audio-play-error'; done(); };
              audio.play().catch(() => { this.error = 'audio-play-blocked（浏览器要求先交互一次）'; done(); });
            });
          }
        } finally {
          this.busy = false;
          if (!this.queue.length) { this.key = ''; this.emit(); }
        }
      },
    };

    /** 按句子边界切到 ~1200 字一块。 */
    function chunkText(text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (clean === '') return [];
      const LIMIT = 1200;
      if (clean.length <= LIMIT) return [clean];
      const pieces = [];
      let rest = clean;
      while (rest.length > LIMIT) {
        let cut = -1;
        for (const ch of ['。', '！', '？', '；', '.', '!', '?', ';', '\n']) {
          const i = rest.lastIndexOf(ch, LIMIT);
          if (i > LIMIT * 0.4) { cut = i + 1; break; }
        }
        if (cut <= 0) cut = LIMIT;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      if (rest.trim() !== '') pieces.push(rest.trim());
      return pieces.filter((p) => p !== '');
    }

    /* ----------------------------- 正文提取 ----------------------------- */
    /** 从任意元素向上找一个「包含 markdown 正文的祖先」（最多 10 层）。 */
    function proseRoot(el) {
      let n = el;
      for (let i = 0; i < 10 && n && n !== document.body; i++) {
        if (n.querySelector && n.querySelector('[class*="markdown"]')) return n;
        n = n.parentElement;
      }
      return null;
    }
    /** 提取可朗读正文：丢掉代码块/代码行内，合并空白。 */
    function speakableText(root) {
      if (!root) return '';
      const clone = root.cloneNode(true);
      clone.querySelectorAll('pre, code, script, style').forEach((e) => e.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function hashKey(text) {
      let h = 5381;
      for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
      return 't' + (h >>> 0).toString(36) + '-' + text.length;
    }

    /* ----------------------------- 会话感知 -----------------------------
     * 同一页面可能同时开着多个会话（分栏 / 新标签页）。朗读必须严格绑定到
     * 「当前选中的会话」：后台会话默认不读。
     *  - sessionsSvc（ctx.get('sessions')）给出当前会话 id 与标题；
     *  - 每个会话里的输入框开关挂载时把自己的会话 id + DOM 锚点登记进 registry，
     *    自动朗读时只读「当前会话 id 对应那个容器」里的正文。 */
    let sessionsSvc = null;
    const sessionRegistry = new Map();   // sessionId -> { composerEl }
    function currentSessionId() {
      try { return sessionsSvc && sessionsSvc.list ? sessionsSvc.list.getSnapshot().current : undefined; } catch { return undefined; }
    }
    function sessionTitleOf(id) {
      try {
        const snap = sessionsSvc && sessionsSvc.list ? sessionsSvc.list.getSnapshot() : null;
        if (!snap || !id) return '';
        const s = snap.byId && snap.byId[id];
        return (s && (s.displayTitle || s.title)) || '';
      } catch { return ''; }
    }
    /** 从会话的输入框锚点向上找到「包含 markdown 正文的容器」。 */
    function containerOfSession(id) {
      const entry = sessionRegistry.get(id);
      if (!entry || !entry.composerEl || !entry.composerEl.isConnected) return null;
      let n = entry.composerEl;
      for (let i = 0; i < 14 && n && n !== document.body; i++) {
        if (n.querySelector && n.querySelector('[class*="markdown"]')) return n;
        n = n.parentElement;
      }
      return null;
    }
    /** 兜底：注册表里查不到（会话 id 缺失等）时，取当前「可见」的输入框所在容器。 */
    function containerOfVisibleComposer() {
      const cards = [].slice.call(document.querySelectorAll('[data-composer-card]'));
      for (const card of cards) {
        if (!card.isConnected || card.offsetParent === null) continue;
        let n = card;
        for (let i = 0; i < 14 && n && n !== document.body; i++) {
          if (n.querySelector && n.querySelector('[class*="markdown"]')) return n;
          n = n.parentElement;
        }
      }
      return null;
    }

    /* ----------------------------- 图标 ----------------------------- */
    function svg(paths, size) {
      return react.createElement('svg', {
        width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, stroke: 'currentColor',
      }, paths);
    }
    const P = (d, extra) => react.createElement('path', Object.assign({ d, strokeLinejoin: 'round' }, extra || {}));
    // 喇叭本体
    const HORN = 'M8.5 2.5 4.5 5.5H2.5v5h2l4 3z';
    // 播放中：两条声波
    const WAVES = [
      P('M10.8 6.2a3.2 3.2 0 0 1 0 3.6', { strokeLinecap: 'round' }),
      P('M12.6 4.6a5.6 5.6 0 0 1 0 6.8', { strokeLinecap: 'round' }),
    ];
    // 静默：一条斜杠
    const MUTED = P('M10.5 6.5l3.5 3.5M14 6.5l-3.5 3.5', { strokeLinecap: 'round' });
    // 停止方块
    const STOP = react.createElement('rect', { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1.2, fill: 'currentColor', stroke: 'none' });

    /* ----------------------------- 每条回复下的小喇叭 ----------------------------- */
    const btnBase = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 26, height: 26, borderRadius: 7, border: 'none', padding: 0,
      background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      cursor: 'pointer', flex: '0 0 auto',
    };
    function MessageSpeakButton(props) {
      const messageId = props && props.messageId;
      const sessionId = props && props.sessionId;
      const [snap, setSnap] = react.useState(player.snapshot());
      const [, setTick] = react.useState(0);
      react.useEffect(() => player.subscribe(setSnap), []);
      react.useEffect(() => {
        // 切换当前会话时重渲染（后台会话的按钮要变灰）
        if (!sessionsSvc || !sessionsSvc.list || !sessionsSvc.list.subscribe) return undefined;
        return sessionsSvc.list.subscribe(() => setTick((t) => t + 1));
      }, []);
      // 后台会话（非当前选中）默认不读
      const isActive = !sessionId || sessionId === currentSessionId();
      const sessionName = sessionTitleOf(sessionId) || '后台会话';
      // 从渲染位置向上找到本条消息的正文
      const ref = react.useRef(null);
      const readThis = () => {
        if (!isActive) return;
        const root = ref.current ? proseRoot(ref.current) : null;
        const text = speakableText(root);
        if (text === '') return;
        const key = hashKey(text);
        if (snap.playing && snap.key === key) player.stop();
        else player.play(text, key, sessionName);
      };
      const isThis = snap.playing && ref.current && (function () {
        const root = proseRoot(ref.current);
        return root ? snap.key === hashKey(speakableText(root)) : false;
      })();
      return react.createElement('button', {
        ref,
        type: 'button',
        className: 'dsh-tts-msg-btn',
        title: isThis ? '停止朗读本条回复' : (isActive ? '朗读本条回复' : '后台会话不朗读（切到该会话再点）'),
        'aria-label': isThis ? '停止朗读本条回复' : (isActive ? '朗读本条回复' : '后台会话不朗读'),
        disabled: !isActive,
        onClick: readThis,
        style: Object.assign({}, btnBase, isThis ? { color: 'var(--dsw-static-deepseek-500, #4d6bfe)' } : null, !isActive ? { opacity: 0.4, cursor: 'default' } : null),
      }, svg(isThis ? [P(HORN), STOP] : [P(HORN)].concat(WAVES)));
    }

    /* ----------------------------- 输入框旁的自动朗读开关 ----------------------------- */
    function AutoReadToggle(props) {
      const sessionId = props && props.sessionId;
      const [cfg, setCfg] = react.useState(config);
      react.useEffect(() => subscribe(setCfg), []);
      // 把本会话的输入框锚点登记进 registry，自动朗读靠它定位「当前会话的正文容器」
      const ref = react.useRef(null);
      react.useEffect(() => {
        if (!sessionId) return undefined;
        const el = ref.current ? ref.current.closest('[data-composer-card]') || ref.current : null;
        sessionRegistry.set(sessionId, { composerEl: el });
        return () => { const cur = sessionRegistry.get(sessionId); if (cur && cur.composerEl === el) sessionRegistry.delete(sessionId); };
      }, [sessionId]);
      const on = cfg.auto === true;
      return react.createElement('button', {
        ref,
        type: 'button',
        className: 'dsh-tts-auto-toggle',
        title: on ? '自动朗读已开：当前选中的会话每条新回复生成后自动朗读（点一下关闭）' : '自动朗读已关：只手动点小喇叭才朗读（点一下开启）',
        'aria-label': '自动朗读开关，当前' + (on ? '开' : '关'),
        'aria-pressed': on,
        onClick: () => saveConfig({ auto: !on }),
        style: Object.assign({}, btnBase, {
          width: 30, height: 30, borderRadius: 8,
          color: on ? 'var(--dsw-static-deepseek-500, #4d6bfe)' : 'var(--dsw-alias-label-tertiary, #8a8a8a)',
          background: on ? 'color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 10%, transparent)' : 'transparent',
        }),
      }, svg(on ? [P(HORN)].concat(WAVES) : [P(HORN), MUTED], 17));
    }

    /* ----------------------------- 头部「朗读」芯片 + 设置面板 ----------------------------- */
    const chipStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px',
      borderRadius: 999, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))',
      background: 'transparent', color: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      fontSize: 12, lineHeight: '18px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
    };
    const cardStyle = {
      position: 'fixed', top: 54, right: 14, zIndex: 60, width: 380, maxWidth: 'calc(100vw - 28px)',
      maxHeight: 'calc(100vh - 90px)', overflow: 'auto', padding: '12px 14px',
      borderRadius: 12, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-raised, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #222)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.22)', fontSize: 12, lineHeight: '18px',
      fontFamily: 'inherit',
    };
    const fieldStyle = { width: '100%', boxSizing: 'border-box', marginTop: 3, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', borderRadius: 8, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.4))', background: 'transparent', color: 'inherit' };
    const labelStyle2 = { display: 'block', marginTop: 9, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' };

    function SettingsPanel(props) {
      const [cfg, setCfg] = react.useState(config);
      const [draft, setDraft] = react.useState(config);
      react.useEffect(() => subscribe((c) => { setCfg(c); setDraft(c); }), []);
      const [note, setNote] = react.useState('');
      const [testing, setTesting] = react.useState(false);
      const set = (k) => (e) => setDraft(Object.assign({}, draft, { [k]: e.target.value }));
      const save = () => {
        saveConfig({
          endpoint: String(draft.endpoint || '').trim(),
          apiKey: String(draft.apiKey || ''),
          model: String(draft.model || '').trim(),
          voice: String(draft.voice || '').trim(),
          speed: Number(draft.speed) || 1,
          format: String(draft.format || 'mp3').trim(),
        });
        setNote('已保存（同步到宿主，所有窗口——包括手机端——共用这份配置）');
      };
      const test = () => {
        save();
        setTesting(true); setNote('合成中…');
        player.play('你好，这是朗读测试。如果听到这句话，说明配置已经通了。', 'test-' + Date.now());
        const off = player.subscribe((s) => {
          if (!s.playing) {
            off();
            setTesting(false);
            setNote(s.error !== '' ? '失败：' + s.error : '播放完成 ✓');
          }
        });
      };
      return react.createElement('div', { style: cardStyle }, [
        react.createElement('div', { key: 'h', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } }, [
          react.createElement('strong', { key: 't', style: { fontSize: 13 } }, '朗读设置（OpenAI 兼容 TTS）'),
          react.createElement('button', { key: 'c', onClick: props.close, style: Object.assign({}, chipStyle, { padding: '2px 8px' }) }, '关闭'),
        ]),
        react.createElement('div', { key: 'cfg', style: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', marginTop: 4 } },
          '自动朗读：' + (cfg.auto === true ? '开（新回复生成后自动朗读）' : '关（只手动朗读）')),
        react.createElement('label', { key: 'l0', style: labelStyle2 }, '自动朗读范围'),
        react.createElement('select', {
          key: 's0', style: fieldStyle, value: draft.autoScope || 'tail',
          onChange: (e) => { setDraft(Object.assign({}, draft, { autoScope: e.target.value })); saveConfig({ autoScope: e.target.value }); },
        }, [
          react.createElement('option', { key: 'tail', value: 'tail' }, '只读末尾总结段落（遇到表格/代码/标题即止，最多 6 段）'),
          react.createElement('option', { key: 'full', value: 'full' }, '读全文（含表格等全部正文）'),
        ]),
        react.createElement('label', { key: 'l1', style: labelStyle2 }, '接口地址（base，如 https://api.example.com/v1）'),
        react.createElement('input', { key: 'i1', style: fieldStyle, value: draft.endpoint || '', placeholder: 'https://api.example.com/v1', onChange: set('endpoint') }),
        react.createElement('label', { key: 'l2', style: labelStyle2 }, 'API Key（留空则不发送 Authorization）'),
        react.createElement('input', { key: 'i2', style: fieldStyle, type: 'password', value: draft.apiKey || '', placeholder: 'sk-…', onChange: set('apiKey') }),
        react.createElement('div', { key: 'row', style: { display: 'flex', gap: 8 } }, [
          react.createElement('div', { key: 'c1', style: { flex: 1 } }, [
            react.createElement('label', { style: labelStyle2 }, '模型'),
            react.createElement('input', { style: fieldStyle, value: draft.model || '', placeholder: 'tts-1', onChange: set('model') }),
          ]),
          react.createElement('div', { key: 'c2', style: { flex: 1 } }, [
            react.createElement('label', { style: labelStyle2 }, '音色 voice'),
            react.createElement('input', { style: fieldStyle, value: draft.voice || '', placeholder: 'alloy', onChange: set('voice') }),
          ]),
        ]),
        react.createElement('div', { key: 'row2', style: { display: 'flex', gap: 8 } }, [
          react.createElement('div', { key: 'c3', style: { width: 90 } }, [
            react.createElement('label', { style: labelStyle2 }, '语速 0.25–4'),
            react.createElement('input', { style: fieldStyle, value: String(draft.speed != null ? draft.speed : 1), onChange: set('speed') }),
          ]),
          react.createElement('div', { key: 'c4', style: { width: 110 } }, [
            react.createElement('label', { style: labelStyle2 }, '格式'),
            react.createElement('input', { style: fieldStyle, value: draft.format || 'mp3', onChange: set('format') }),
          ]),
        ]),
        react.createElement('div', { key: 'btns', style: { display: 'flex', gap: 8, marginTop: 12 } }, [
          react.createElement('button', { key: 's', onClick: save, style: Object.assign({}, chipStyle, { color: 'var(--dsw-static-deepseek-500, #4d6bfe)', borderColor: 'currentColor' }) }, '保存'),
          react.createElement('button', { key: 't', onClick: test, disabled: testing, style: Object.assign({}, chipStyle, { padding: '2px 8px' }) }, testing ? '合成中…' : '试听一句'),
          react.createElement('button', { key: 'x', onClick: () => { player.stop(); }, style: Object.assign({}, chipStyle, { padding: '2px 8px' }) }, '停止播放'),
        ]),
        note !== '' ? react.createElement('div', { key: 'n', style: { marginTop: 8, color: note.indexOf('失败') === 0 ? 'var(--dsw-alias-state-error-primary, #d92d20)' : 'var(--dsw-alias-label-tertiary, #8a8a8a)', wordBreak: 'break-all' } }, note) : null,
        player.error !== '' ? react.createElement('div', { key: 'e', style: { marginTop: 6, color: 'var(--dsw-alias-state-error-primary, #d92d20)', wordBreak: 'break-all' } }, '上次错误：' + player.error) : null,
      ]);
    }

    function TtsChip() {
      const [open, setOpen] = react.useState(false);
      const [snap, setSnap] = react.useState(player.snapshot());
      react.useEffect(() => player.subscribe(setSnap), []);
      const status = snap.playing ? '朗读中' : (config.endpoint ? '就绪' : '未配置');
      const readingLabel = snap.playing ? (snap.label || '当前会话') : '';
      return react.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' } }, [
        react.createElement('button', {
          key: 'chip', className: 'dsh-tts-chip',
          onClick: () => setOpen(!open),
          title: snap.playing
            ? '正在朗读「' + readingLabel + '」（第 ' + snap.chunk + '/' + snap.total + ' 段）。点开设置；旁边的方块按钮立刻停止。'
            : '朗读（TTS）：' + status + '。点开配置接口地址、音色、语速。',
          style: Object.assign({}, chipStyle, snap.playing ? {
            color: 'var(--dsw-static-deepseek-500, #4d6bfe)',
            borderColor: 'currentColor',
            maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis',
          } : null),
        }, [
          react.createElement('span', { key: 'i', style: { display: 'inline-flex' } }, svg([P(HORN)], 13)),
          react.createElement('span', {
            key: 't',
            style: snap.playing ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : null,
          }, snap.playing ? ('朗读中 · ' + readingLabel) : ('朗读 ' + status)),
        ]),
        snap.playing ? react.createElement('button', {
          key: 'stop', className: 'dsh-tts-chip-stop',
          onClick: () => player.stop(),
          title: '立刻停止朗读「' + readingLabel + '」',
          'aria-label': '停止朗读',
          style: Object.assign({}, chipStyle, { padding: '3px 8px', color: 'var(--dsw-alias-state-error-primary, #d92d20)' }),
        }, svg([P(HORN), STOP], 13)) : null,
        open ? react.createElement(SettingsPanel, { key: 'panel', close: () => setOpen(false) }) : null,
      ]);
    }

    /* ----------------------------- 自动朗读（监听回合结束） ----------------------------- */
    let generating = false;
    let lastAutoKey = '';
    function composerPrimaryLabel(container) {
      const root = container || document;
      const card = root.querySelector && root.querySelector('[data-composer-card]');
      if (!card) return '';
      const btn = [].slice.call(card.querySelectorAll('button')).find((b) => {
        const t = b.getAttribute('aria-label') || '';
        return t === '发送消息' || t === '停止生成';
      });
      return btn ? (btn.getAttribute('aria-label') || '') : '';
    }
    function lastProseText(container) {
      const root = container || document;
      const all = root.querySelectorAll ? root.querySelectorAll('[class*="markdown"]') : [];
      if (!all.length) return '';
      return speakableText(all[all.length - 1]);
    }
    /**
     * 只取回复末尾「连续的普通段落」：从最后一个 markdown 块的子元素末尾往前收，
     * 只要还是简单段落（p / 纯文本）就收进来；一碰到表格、代码块、标题、列表就停。
     * 典型回复的结构是前面一堆表格/代码、最后一段文字总结——自动朗读就只读那段总结。
     */
    function tailProseText(container) {
      const root = container || document;
      const all = root.querySelectorAll ? root.querySelectorAll('[class*="markdown"]') : [];
      if (!all.length) return '';
      const md = all[all.length - 1];
      const STOP = new Set(['TABLE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'HR']);
      const parts = [];
      const kids = md.children || [];
      for (let i = kids.length - 1; i >= 0; i--) {
        const el = kids[i];
        if (STOP.has(el.tagName)) break;
        // 段落里嵌了块级元素（表格/列表等）也停
        if (el.querySelector && el.querySelector('table,pre,ul,ol,h1,h2,h3,h4,h5,h6')) break;
        const t = speakableText(el);
        if (t === '') continue;
        parts.unshift(t);
        // 最多收 6 段，防止整篇纯文本时等于读全文
        if (parts.length >= 6) break;
      }
      return parts.join(' ');
    }
    function autoSpeakTick() {
      // 只盯「当前选中的会话」：后台会话（分栏/新标签页）的回合结束一律不触发
      const activeId = currentSessionId();
      let container = activeId !== undefined ? containerOfSession(activeId) : null;
      if (!container) container = containerOfVisibleComposer();   // 兜底：会话 id 缺失时退回可见容器
      if (!container) { if (generating) generating = false; return; }
      const label = composerPrimaryLabel(container);
      if (label === '停止生成') { generating = true; return; }
      if (generating && label === '发送消息') {
        generating = false;
        // 等最后一帧渲染完
        setTimeout(() => {
          if (config.auto !== true) return;
          const nowId = currentSessionId();
          if (nowId === undefined) return;
          const scope = containerOfSession(nowId);
          if (!scope) return;
          const text = config.autoScope === 'full' ? lastProseText(scope) : tailProseText(scope);
          if (text === '' || text.length < 2) return;
          const key = nowId + ':' + hashKey(text);
          if (key === lastAutoKey) return;
          lastAutoKey = key;
          player.play(text, key, sessionTitleOf(nowId) || '当前会话');
        }, 900);
      }
    }
    function startAutoWatch() {
      const observer = new MutationObserver(() => autoSpeakTick());
      const arm = () => {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        else setTimeout(arm, 1000);
      };
      arm();
    }

    /* ----------------------------- 装配 ----------------------------- */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      // 会话服务：current / byId / displayTitle 都从这里来；拿不到就退化为旧行为
      try { sessionsSvc = ctx.get('sessions') || null; } catch { sessionsSvc = null; }
      // 1) 每条助手回复的操作行（inject 把 sessionId 带进组件 props）
      slots.inject('conversation.chat.assistant-actions', () => slots.register(
        {
          name: 'conversation.chat.assistant-actions', id: 'dsh-tts-speak', order: 15,
          inject: (sessionId) => ({ sessionId }),
        },
        (props) => MessageSpeakButton(props),
      ));
      // 2) 输入框右侧的自动朗读开关
      slots.inject('conversation.input.right', () => slots.register(
        {
          name: 'conversation.input.right', id: 'dsh-tts-auto', order: 90,
          inject: (sessionId) => ({ sessionId }),
        },
        (props) => AutoReadToggle(props),
      ));
      // 3) 会话头部的「朗读」芯片（设置面板）
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-tts-chip', order: 14 },
        (props) => TtsChip(props),
      ));
      startAutoWatch();
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    // 调试/手动控制入口
    window.__dshTts = {
      play: (text) => player.play(text, 'manual-' + Date.now()),
      stop: () => player.stop(),
      config: () => Object.assign({}, config),
      saveConfig,
    };
    return module.exports;
  },
});
