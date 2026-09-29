/* 爆点逃跑 · 前端主逻辑（原生 JS，无框架） */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var S = {
    me: null, cfg: {}, ws: null,
    round: 0, phase: 'idle', bet: 10, hasBet: false, escDone: false,
    bets: new Map(), history: [], reconnect: 0,
    // 两个独立开关：bgmOn = 背景音乐，sfxOn = 音效
    bgmOn: true, sfxOn: true,
    flightStart: 0, flightMs: 0, raf: 0, soundOn: false,
    bgmReady: false, boomRate: 0,
    // 登录幂等守卫：非空 = 本页面生命周期已发起过登录，见 runLoginOnce()
    logging: null,
  };
  var chart = null, audio = null;

  /* ---------------- 音频（原版 bgmusic.mp3 + 合成音效） ---------------- */
  // 直接用 HTML 里那个 <audio id="bgm">，不要在 JS 里再造一个
  var bgmEl = document.getElementById('bgm');

  /**
   * 音频解锁（浏览器策略：必须由真实用户手势触发，且 AudioContext 要 resume）
   * 一次性挂到所有可能的交互事件上，成功后立刻解绑。
   */
  var audioUnlocked = false;
  function tryUnlockAudio() {
    if (audioUnlocked) return;
    initAudio();
    var ok = false;
    if (audio && audio.state === 'suspended') { try { audio.resume(); } catch (_) {} }
    if (audio && audio.state === 'running') ok = true;
    if (bgmEl && S.bgmOn) {
      try {
        var p = bgmEl.play();
        if (p && p.then) p.then(function () { S.bgmReady = true; audioUnlocked = true; })
                        .catch(function () {});
        else audioUnlocked = true;
      } catch (_) {}
    }
    if (ok) audioUnlocked = true;
  }

  function initAudio() {
    if (audio) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      audio = new AC();
    } catch (_) { audio = null; }
    // 背景音压低到 18%，不抢音效
    if (bgmEl) bgmEl.volume = 0.05;
  }
  function playBgm() {
    if (!S.sfxOn) return;
    initAudio();
    if (!bgmEl) return;
    if (audio && audio.state === 'suspended') { try { audio.resume(); } catch (_) {} }
    if (S.bgmReady) { try { bgmEl.play(); } catch (_) {} return; }
    // 首次播放需要用户手势
    try {
      var p = bgmEl.play();
      if (p && p.then) p.then(function () { S.bgmReady = true; }).catch(function () {});
    } catch (_) {}
  }
  function stopBgm() { if (bgmEl) { try { bgmEl.pause(); } catch (_) {} } }

  /**
   * 爆炸音效：用户提供的真实录音 boom.mp3
   * （由 93846__cgeffex__huge-explosion6.flac 转码，192kbps MP3，8.5 秒）
   * 走独立的 <audio> 元素，不依赖 AudioContext —— 只要页面被交互过就一定响。
   */
  var boomEl = null;
  function sfxBoom() {
    if (!S.sfxOn) return;
    if (!boomEl) {
      boomEl = new Audio('/assets/sound/boom.mp3');
      boomEl.preload = 'auto';
      boomEl.volume = 0.85;
    }
    try {
      boomEl.currentTime = 0;
      var p = boomEl.play();
      if (p && p.catch) p.catch(function () { sfxBoomSynth(); });
    } catch (_) { sfxBoomSynth(); }
  }

  /** 兜底：真实音频没解锁时用合成音（低频冲击 + 噪声爆裂） */
  function sfxBoomSynth() {
    initAudio();
    if (!audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 0.55);
      g.gain.setValueAtTime(1.0, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + 0.62);
      var len = Math.floor(audio.sampleRate * 0.35);
      var buf = audio.createBuffer(1, len, audio.sampleRate);
      var ch = buf.getChannelData(0);
      for (var i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      var src = audio.createBufferSource(), ng = audio.createGain();
      src.buffer = buf;
      ng.gain.setValueAtTime(0.56, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      var f = audio.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 2400;
      src.connect(f); f.connect(ng); ng.connect(audio.destination);
      src.start(t);
    } catch (_) {}
  }

  /** 下单音效：短促的「叮」+ 上行小二度 */
  function sfxBet() {
    if (!S.sfxOn) return;
    initAudio();
    if (!audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
      g.gain.setValueAtTime(0.44, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + 0.18);
    } catch (_) {}
  }

  /** 起飞音效：往上扫的引擎声 */
  function sfxTakeoff() {
    if (!S.sfxOn) return;
    initAudio();
    if (!audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(900, t + 0.28);
      g.gain.setValueAtTime(0.10, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      var f = audio.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.setValueAtTime(700, t);
      f.frequency.exponentialRampToValueAtTime(3200, t + 0.3);
      o.connect(f); f.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + 0.34);
    } catch (_) {}
  }

  /** 逃跑成功音效：清脆上行琶音（和按钮音一样大） */
  function sfxEscape(mult) {
    if (!S.sfxOn) return;
    initAudio();
    if (!audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      var notes = mult >= 10 ? [523, 659, 784, 1047, 1319] : [523, 659, 784];
      notes.forEach(function (f0, i) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = 'triangle';
        o.frequency.value = f0;
        var st = t + i * 0.055;
        g.gain.setValueAtTime(0, st);
        g.gain.linearRampToValueAtTime(0.44, st + 0.012);   // 加大到与按钮音同级
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.26);
        o.connect(g); g.connect(audio.destination);
        o.start(st); o.stop(st + 0.28);
      });
    } catch (_) {}
  }

  /**
   * 爆炸时的输赢音效。
   * 赢了（我逃了）走上扬和弦，输了走下行小三度 —— 和爆炸视觉同步，
   * 音量与按钮音同级（0.44），让「赢了」有明确的正反馈。
   */
  function sfxResult(won) {
    if (!S.sfxOn) return;
    initAudio();
    if (!audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime + 0.10;      // 稍微错开爆炸音，避免糊在一起
      var notes = won ? [659, 831, 988, 1319] : [440, 415, 349];
      notes.forEach(function (f0, i) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = won ? 'triangle' : 'sine';
        o.frequency.value = f0;
        var st = t + i * 0.07;
        g.gain.setValueAtTime(0, st);
        g.gain.linearRampToValueAtTime(0.44, st + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.30);
        o.connect(g); g.connect(audio.destination);
        o.start(st); o.stop(st + 0.32);
      });
    } catch (_) {}
  }

  /** 爆点倒数的滴答声（倍率越高越急） */
  function sfxTick(rate) {
    if (!S.sfxOn) return;
    initAudio();
    if (!audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square';
      o.frequency.value = 700 + Math.min(rate, 30) * 45;
      g.gain.setValueAtTime(0.045, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + 0.05);
    } catch (_) {}
  }

  /* ---------------- 工具 ---------------- */
  function api(path, opt) {
    opt = opt || {};
    return fetch(path, {
      method: opt.method || 'GET',
      headers: opt.body ? { 'Content-Type': 'application/json' } : {},
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function fmt(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // 余额过百万改用 K/M/B 缩写，避免「1,234,567.00」把界面撑开。
  // 阈值：<10K 保持两位小数的完整写法；>=10K 用一位小数的缩写。
  function fmtC(n) {
    var v = Number(n) || 0;
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return fmt(v);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function avatar(u) {
    if (!u) return '/assets/avatar-default.svg';
    if (u.avatar) return u.avatar;
    return 'https://cdn.discordapp.com/embed/avatars/' + (parseInt(String(u.discordId || 0).replace(/\D/g, '').slice(0, 4) || 0, 10) % 5) + '.png';
  }
  var toastT = 0;
  function toast(msg, kind) {
    var old = $('.toast'); if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'toast ' + (kind || '');
    d.textContent = msg;
    document.body.appendChild(d);
    clearTimeout(toastT);
    toastT = setTimeout(function () { d.remove(); }, 2200);
  }
  function beep(freq, dur, type) {
    if (!S.sfxOn || !audio) return;
    try {
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.06, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (dur || 0.12));
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + (dur || 0.12));
    } catch (_) {}
  }

  /* ================================================================
     Discord 登录（方案 A：Activity 内嵌）
     ------------------------------------------------------------
     参照 Duncan588 的 dashboard/static/js/discord-activity.js 重写。
     之前这版四个问题，用户报的现象是「点了没反应 / 一直加载中」：

     1. SDK 走 jsDelivr CDN —— Discord 的 iframe 网络代理会拦外部域名，
        模块加载失败时 authorize() 根本不会执行，也没有任何报错。
        现在打包成本地单文件 /js/vendor/discord-activity-sdk.mjs。
     2. ready() / authorize() 没有超时 —— 弱网下 Promise 永远不 resolve，
        页面卡死在加载动画上，看起来就是「一直在加载中」。
     3. 遇到 429 自动重试 —— authorize 返回的 code 是一次性的，
        连续 authorize 会继续吃配额，把限流越搞越久。
        现在改成冷却 + 倒计时，冷却完由用户手动发起。
     4. 只用内存变量 S.logging 做幂等 —— 移动端 WebView 被挂起时
        内存态全丢，重进页面会再发一轮。现在用 sessionStorage 带时间戳的锁。
     ================================================================ */

  var SDK_URL = '/js/vendor/discord-activity-sdk.mjs';
  var SDK_READY_TIMEOUT_MS = 6000;      // ready() 不回包
  var AUTHORIZE_TIMEOUT_MS = 8000;      // authorize() 不回包
  var IN_FLIGHT_MAX_AGE = 10 * 60 * 1000;   // 锁最长存活 10 分钟
  var IN_FLIGHT_RETRY_MS = 8000;        // 疑似陈旧锁的自愈等待
  var K_AUTHED = 'bd_authed';
  var K_INFLIGHT = 'bd_auth_inflight';
  var K_COOLDOWN = 'bd_auth_cooldown';
  var sdkPromise = null, cooldownTimer = null;

  function inDiscord() {
    return /frame_id/.test(location.search) || (function () {
      try { return window.self !== window.top; } catch (_) { return true; }
    })();
  }

  /**
   * Discord 移动端小活动会用一个自己的顶栏（频道名 + 关闭按钮）盖住 iframe 上方，
   * 表现为页面顶部被遮住 —— 头像和名字那一行点不到。
   * iOS 的 env(safe-area-inset-top) 在 iframe 里恒为 0，挡不住，所以手动加一段偏移。
   * 只在【移动端 + 跑在 iframe 里】时生效，桌面端和普通网页都是 0，不影响布局。
   */
  (function applyActivityTopInset() {
    if (!inDiscord()) return;
    if (window.innerWidth > 720) return;          // 桌面端 Discord 侧栏是竖的，不遮顶部
    var px = window.innerWidth <= 420 ? 46 : 56;  // iPhone 竖屏 / 平板横屏
    document.documentElement.style.setProperty('--activity-top', px + 'px');
  })();

  /** 给 Promise 加超时，避免 RPC 桥接不回包时永久挂起。 */
  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var e = new Error(message); e.timedOut = true; reject(e);
      }, ms);
      promise.then(function (v) {
        if (settled) return; settled = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (settled) return; settled = true; clearTimeout(timer); reject(e);
      });
    });
  }

  /** SDK 本地单文件，只加载一次；失败后允许重试。 */
  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = import(SDK_URL)
      .then(function (mod) {
        if (!mod || !mod.DiscordSDK) throw new Error('SDK 导出缺失');
        return new mod.DiscordSDK(window.__DC_ID);
      })
      .catch(function (e) { sdkPromise = null; throw e; });   // 允许重试
    return sdkPromise;
  }

  function login() {
    if (inDiscord()) return runLoginOnce();
    location.href = '/auth/login';
  }

  /* ---------- 幂等守卫 ---------- */

  function hasRecentInFlight() {
    var t = Number(sessionStorage.getItem(K_INFLIGHT) || 0);
    if (!t || Date.now() - t > IN_FLIGHT_MAX_AGE) { sessionStorage.removeItem(K_INFLIGHT); return false; }
    return true;
  }
  function markInFlight() { sessionStorage.setItem(K_INFLIGHT, String(Date.now())); }
  function clearInFlight() { sessionStorage.removeItem(K_INFLIGHT); }

  /**
   * 单一登录入口 + 幂等守卫。
   * 按钮点击、初始化、SDK 回调重试共用它，保证生命周期内只发一轮。
   * 内存变量 + sessionStorage 双保险（移动端 WebView 被挂起时内存态会丢）。
   */
  function runLoginOnce() {
    if (S.logging) return S.logging;
    S.logging = loginActivity().catch(function (e) {
      S.logging = null;         // 允许重试
      throw e;
    });
    return S.logging;
  }

  /* ---------- 429 冷却 ---------- */

  function cooldownLeft() {
    var until = Number(sessionStorage.getItem(K_COOLDOWN) || 0);
    try { until = Math.max(until, Number(localStorage.getItem(K_COOLDOWN) || 0)); } catch (_) {}
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  }
  function setCooldown(sec) {
    sec = Math.ceil(Math.min(Number(sec) || 0, 86400));
    if (sec <= 0) return 0;
    var until = String(Date.now() + sec * 1000);
    sessionStorage.setItem(K_COOLDOWN, until);
    try { localStorage.setItem(K_COOLDOWN, until); } catch (_) {}
    return sec;
  }
  function clearCooldown() {
    sessionStorage.removeItem(K_COOLDOWN);
    try { localStorage.removeItem(K_COOLDOWN); } catch (_) {}
  }
  function fmtWait(s) {
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    return m + ' 分' + (s % 60 ? ' ' + (s % 60) + ' 秒' : '');
  }
  function isRateLimit(e) {
    if (!e) return false;
    if (e.retry_after != null || e.rate_limited) return true;
    return /rate.?limit|速率|限流/i.test(e.message || '');
  }
  function showRateLimit(e) {
    var sec = setCooldown(e && e.retry_after ? e.retry_after : 60);
    showAuthFail('Discord 请求过于频繁' + (sec ? '，请等待 ' + fmtWait(sec) : ''), sec);
  }
  function startCooldownCountdown() {
    if (cooldownTimer) clearInterval(cooldownTimer);
    cooldownTimer = setInterval(function () {
      var left = cooldownLeft();
      var m = $('#authMsg');
      if (left > 0) {
        if (m) m.textContent = 'Discord 请求过于频繁，请等待 ' + fmtWait(left) + ' 后再试';
        $('#btnDiscord').disabled = true;
      } else {
        clearInterval(cooldownTimer); cooldownTimer = null;
        clearCooldown();
        if (m) m.textContent = '冷却结束，可以重新登录';
        $('#btnDiscord').disabled = false;
      }
    }, 1000);
  }

  /* ---------- 主流程 ---------- */

  function loginActivity() {
    if (!window.__DC_ID) { showAuthFail('未配置 Discord Client ID'); return Promise.reject(new Error('no clientId')); }

    var cool = cooldownLeft();
    if (cool > 0) { startCooldownCountdown(); return Promise.reject(new Error('rate limited')); }

    if (hasRecentInFlight()) {
      // 上次尝试被移动端 WebView 挂起打断，从未完成 —— 短暂等待后清锁重试一次，
      // 而不是让用户对着转圈等 10 分钟锁过期。
      setTimeout(function () {
        if (sessionStorage.getItem(K_AUTHED) === '1') return;
        clearInFlight();
        runLoginOnce();
      }, IN_FLIGHT_RETRY_MS);
      return Promise.reject(new Error('stale lock'));
    }

    markInFlight();
    $('#authMsg').textContent = '正在通过 Discord 登录…';

    var sdk = null;
    return loadSdk()
      .then(function (s) {
        sdk = s;
        return withTimeout(s.ready(), SDK_READY_TIMEOUT_MS, 'Discord 客户端没有响应（ready 超时）');
      })
      .then(function () {
        // 只用 prompt:'none' 静默授权。失败（首次未同意 / 被限流）时
        // 【不自动重试】—— 交给用户手动再点，避免连续 authorize 吃配额。
        return withTimeout(
          sdk.commands.authorize({
            client_id: window.__DC_ID, response_type: 'code',
            prompt: 'none', scope: ['identify']
          }),
          AUTHORIZE_TIMEOUT_MS, 'Discord 授权请求超时'
        );
      })
      .then(function (resp) {
        if (!resp || !resp.code) throw new Error('Discord 没有返回授权 code');
        return finishLogin(resp.data || resp);
      })
      .then(function (j) {
        clearInFlight();
        sessionStorage.setItem(K_AUTHED, '1');
        return j;
      })
      .catch(function (e) {
        clearInFlight();
        if (isRateLimit(e)) { showRateLimit(e); }
        else { showAuthFail('自动登录失败：' + ((e && e.message) || e)); }
        throw e;
      });
  }

  /** 登录失败时把登录层显示出来，并保留按钮让用户手动重试。 */
  function showAuthFail(msg, withCooldown) {
    $('#auth').hidden = false;
    var m = $('#authMsg');
    if (m) m.textContent = withCooldown ? msg : msg + '，可点击下方按钮重试';
    toast(msg, 'err');
  }

  /**
   * 用 SDK authorize 返回的 {code, state, code_verifier} 换 token。
   * Activity 路径必须带上 SDK 自己生成的 code_verifier（Discord 对 PKCE 强制校验）。
   * 字段名是 snake_case（code_verifier），但 SDK 版本可能变动，两个都读。
   */
  function finishLogin(data) {
    var verifier = data.code_verifier || data.codeVerifier || null;
    if (!verifier) console.warn('[auth] SDK 未返回 code_verifier');
    return api('/api/auth/discord', {
      method: 'POST',
      body: { code: data.code, code_verifier: verifier, inviter: qs('invite') }
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.j.error || '登录失败');
        S.me = r.j.user;
        if (r.j.bonus) toast('欢迎！新人礼 +' + fmtC(r.j.bonus) + ' QUN', 'ok');
        // 验证 cookie 真的生效：Discord 代理可能吞掉 Set-Cookie，
        // 不确认就 start() 会进到一个「看起来登录了但其实没有」的页面。
        return api('/api/me').then(function (chk) {
          if (!chk.j || !chk.j.user) {
            throw new Error('登录会话没有保存，请检查 HTTPS、Cookie 和 Discord URL Mapping');
          }
          S.me = chk.j.user; S.cfg = chk.j.config || S.cfg;
          start();
          history.replaceState(null, '', location.pathname);
          return r.j;
        });
      });
  }

  function qs(k) { return new URLSearchParams(location.search).get(k); }

  /* ---------------- 启动 ---------------- */
  function start() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    $('#nav').hidden = false;
    // ⚠️ chart 必须在 #app 显示【之后】初始化。
    // BoomChart.resize() 用 getBoundingClientRect() 量容器，而 #app 还是
    // hidden 时量到 0×0，resize() 直接 return —— 结果是：
    //   · canvas 缓冲区停在默认 300×150，被 CSS 拉成 564×300（模糊、坐标轴发虚）
    //   · this.plot 从未建立 → 火箭定位代码整段被 if (chart.plot) 跳过
    // 以前它在 /api/me 回调里 new BoomChart()，正好落在 hidden 区间。
    initChart();
    renderMe();
    loadConfig();
    connectWS();
    setInterval(renderBets, 500);
    addEventListener('resize', function () { chart && chart.resize(); });
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }

  /** 只建一次；重复调用时补一次 resize（处理 hidden→visible 的尺寸差）。 */
  function initChart() {
    if (!chart) chart = new BoomChart($('#chart'));
    else chart.resize();
    window.__ch = chart;   // 调试/自动化检查用
  }

  function loadConfig() {
    api('/api/me').then(function (r) {
      if (r.j && r.j.config) S.cfg = r.j.config;
      if (r.j && r.j.user) { S.me = r.j.user; renderMe(); }
    });
  }

  function renderMe() {
    if (!S.me) return;
    $('#meName').textContent = S.me.name || '玩家';
    $('#meAvatar').src = avatar(S.me);
    $('#meCoins').textContent = fmtC(S.me.coins);
  }
  function setCoins(c) { S.me.coins = c; $('#meCoins').textContent = fmtC(c); }

  /* ---------------- WebSocket ---------------- */
  function connectWS() {
    // ⚠️ 不要再无条件拼 ":9501"。
    // 反代部署（boom.monster6324.me）时源站 9501 不对公网开放，浏览器
    // 连不上就永远「连接中」，而服务端日志一片干净（请求根本没到 Node）。
    // 正确做法：非本机部署用【同源相对路径】，由 nginx 的 location /ws
    // 反代到 127.0.0.1:9501，浏览器只看到一个源。
    // 本地开发没有 nginx，仍需直连 WS_PORT —— 用 hostname 判定，
    // 不要用 origin（127.0.0.1:8080 和 127.0.0.1:8090 都是本机）。
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    var url = (isLocal || window.__WS_PORT)
      ? proto + '://' + location.hostname + ':' + (window.__WS_PORT || (S.cfg && S.cfg.wsPort) || 9501) + '/ws'
      : proto + '://' + location.host + '/ws';
    S.ws = new WebSocket(url);

    S.ws.onopen = function () {
      S.reconnect = 0;
      $('#phase').innerHTML = '<b>已连接</b> · 等待下一局';
      beep(660, 0.08);
    };
    S.ws.onclose = function () {
      S.reconnect++;
      $('#phase').textContent = '重连中…(' + S.reconnect + ')';
      setPhase('idle');
      setTimeout(connectWS, Math.min(1000 * S.reconnect, 8000));
    };
    S.ws.onerror = function () {};
    S.ws.onmessage = function (e) {
      var d; try { d = JSON.parse(e.data); } catch (_) { return; }
      onMsg(d);
    };
  }

  function onMsg(d) {
    switch (d.type) {
      case 'hello':
        if (d.jackpot != null) $('#jackpot').textContent = fmtC(d.jackpot);
        if (d.online != null) $('#onlineChip').textContent = '在线 ' + d.online;
        // 中途加入：把当前局完整恢复出来，而不是干等下一条 begin（看起来像假死）
        if (d.current) onJoinCurrent(d.current);
        break;

      case 'begin':
        onBegin(d);
        break;

      case 'bets':
        onBet(d);
        break;

      case 'bets_done':
        // 只是「机器人推完了」，不是封盘。真正的封盘由前端倒计时归零或 takeoff 决定，
        // 否则会提前锁定下注按钮，玩家在剩余几秒里点不了。
        break;

      case 'lock':
        setPhase('locked', d.lockEndAt);
        break;

      case 'takeoff':
        onTakeoff(d);
        break;

      case 'escape':
        onEscape(d);
        break;

      case 'over':
        onOver(d);
        break;

      case 'chat':
        onChat(d);
        break;

      case 'event':
        showEvent(d.name, d.min, d.max);
        break;

      case 'event_end':
        hideEvent();
        break;
    }
  }

  /* ---------------- 限时活动横幅 ---------------- */
  function showEvent(name, min, max) {
    var el = $('#eventBanner');
    if (!el) return;
    $('#eventName').textContent = name || '限时活动';
    $('#eventRange').textContent = (min || 1) + 'x - ' + (max || 10) + 'x 高倍场';
    el.hidden = false;
  }
  function hideEvent() {
    var el = $('#eventBanner');
    if (el) el.hidden = true;
  }

  /* ---------------- 弹幕 ---------------- */
  var dmLane = 0;   // 轮换轨道，避免弹幕叠在一起

  /**
   * 让一条消息从图表左侧飘到右侧。
   * 轨道按 lane 轮转（4 条），并按消息类型给不同颜色。
   */
  function floatDanmaku(d) {
    var layer = $('#danmaku');
    if (!layer) return;
    var el = document.createElement('div');
    var kind = d.kind || 'user';
    el.className = 'dm ' + (kind === 'escape' ? 'escape' : (kind === 'bet' ? 'bet' : (kind === 'user' ? '' : 'sys')));
    var who = d.name ? '<span class="who">' + esc(d.name) + '</span>' : '';
    el.innerHTML = who + esc(d.text || '');
    // 4 条轨道分布在图表高度的 22% / 42% / 62% / 80%
    var lane = dmLane++ % 4;
    el.style.top = (18 + lane * 17) + '%';
    // 飘过时长 6.5~9s，按内容长度略微调整
    var dur = 6.5 + Math.min(2.5, (d.text || '').length * 0.03);
    el.style.animationDuration = dur.toFixed(2) + 's';
    layer.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, dur * 1000 + 300);
    // 最多同时 12 条
    while (layer.children.length > 12) layer.removeChild(layer.firstChild);
  }

  function onChat(d) {
    // 同时在图表上飘一条弹幕
    floatDanmaku(d);
    var box = $('#chatList');
    if (!box) return;
    var row;
    var ts = d.at ? fmtTime(typeof d.at === 'number' ? d.at : String(d.at)) : '';
    if (d.kind === 'user') {
      row = document.createElement('div');
      row.className = 'chat-msg';
      row.innerHTML = '<img src="' + esc(d.avatar || '/assets/avatar-default.svg') + '" alt="">'
        + '<span class="nm">' + esc(d.name || '玩家') + '</span>'
        + '<span class="tx">' + esc(d.text || '') + '</span>'
        + (ts ? '<span class="tm">' + ts + '</span>' : '');
    } else {
      // 系统飘字：xxx 逃了 2.35x / xxx 下注 10 QUN
      row = document.createElement('div');
      row.className = 'chat-msg sys' + (d.kind === 'boom' ? ' win' : '') + (d.kind === 'system' || d.kind === 'bet' ? ' bet' : '');
      row.innerHTML = '<span class="tx">' + (d.name ? esc(d.name) + ' ' : '') + esc(d.text || '') + '</span>'
        + (ts ? '<span class="tm">' + ts + '</span>' : '');
    }
    box.appendChild(row);
    // 最多保留 120 条
    while (box.children.length > 120) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  /** 时间格式化：数字毫秒 / "YYYY-MM-DD HH:mm:ss" → HH:mm */
  function fmtTime(v) {
    var d;
    if (typeof v === 'number') d = new Date(v);
    else {
      var s = String(v).replace(' ', 'T');
      d = new Date(s);
    }
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 载入服务器保留的聊天历史（带日期时间） */
  function loadChatHistory() {
    api('/api/chat/history?limit=60').then(function (r) {
      if (!r.j || !r.j.list || !r.j.list.length) return;
      var box = $('#chatList');
      if (!box) return;
      // 插入到现有消息之前，保持时间顺序
      var frag = document.createDocumentFragment();
      r.j.list.forEach(function (m) {
        var row = document.createElement('div');
        var full = String(m.at || '');
        var t = fmtTime(full) || full.slice(0, 16);
        if (m.kind === 'user') {
          row.className = 'chat-msg';
          row.innerHTML = '<span class="nm">' + esc(m.name) + '</span>'
            + '<span class="tx">' + esc(m.text) + '</span>'
            + '<span class="tm" title="' + esc(full) + '">' + esc(t) + '</span>';
        } else {
          row.className = 'chat-msg sys' + (m.kind === 'bet' ? ' bet' : '');
          row.innerHTML = '<span class="tx">' + esc(m.name) + ' ' + esc(m.text) + '</span>'
            + '<span class="tm" title="' + esc(full) + '">' + esc(t) + '</span>';
        }
        frag.appendChild(row);
      });
      box.insertBefore(frag, box.firstChild);
      box.scrollTop = box.scrollHeight;
    });
  }

  function sendChat() {
    var input = $('#chatText');
    if (!input) return;
    var text = (input.value || '').trim();
    if (!text) return;
    api('/api/chat', { method: 'POST', body: { text: text } }).then(function (r) {
      if (!r.ok) toast(r.j && r.j.error ? r.j.error : '发送失败', 'err');
      else input.value = '';
    });
  }

  /**
   * 中途加入当前进行中的局。
   * 服务端在 hello 里带回了 gid/status/rate/elapsedSec/flightMs/bets，
   * 这里把下注列表、阶段、曲线和火箭一次性对齐 —— 否则新玩家进来只看到
   * 「已连接」，要一直等到本局结束才收到下一条 begin，体验上就是假死。
   */
  function onJoinCurrent(c) {
    S.round = c.gid;
    // ⚠️ hasBet 必须从服务端快照恢复。刷新/中途加入时内存态已丢，
    // 若不恢复：飞行中按钮显示「未下注」且点击走【下注】分支 →
    // 服务端返回「本期已下注」→ 用户反馈「下注后无法逃跑」。
    S.hasBet = !!c.hasBet;
    S.escDone = false;
    if (c.jackpot != null) $('#jackpot').textContent = fmtC(c.jackpot);

    // 恢复本局玩家列表
    S.bets.clear();
    var list = $('#betsList');
    list.innerHTML = '';
    var rows = (c.bets || []).filter(function (r) { return r.memberid; });
    rows.forEach(function (r) {
      S.bets.set(String(r.memberid), {
        id: r.memberid, name: r.nickname, avatar: r.head_url,
        bet: r.bet, rate: 0, me: String(r.memberid) === String(S.me && S.me.id),
      });
    });
    if (!rows.length) list.innerHTML = '<div class="bets-empty">本局暂无下注</div>';

    if (c.status === 'flying') {
      // 飞行中：从已飞秒数把曲线、火箭、倍率、倒计时全部补上
      var total = (c.flightMs || 0) + (c.elapsedSec || 0) * 1000;
      onTakeoff({ gid: c.gid, flightMs: total });
      // 覆盖 flightStart 为「已飞 elapsedSec」，让 tick 接着往下走
      S.flightMs = total;
      S.flightStart = performance.now() - (c.elapsedSec || 0) * 1000;
      if (chart) {
        chart.reset();
        var SC = S.cfg.flightScale || 2.5;
        chart.setState({ status: 'flying', sec: c.elapsedSec || 0, scale: SC });
      }
    } else {
      // ⚠️ 必须把服务端的绝对截止时间传下去。缺了它 setPhase 会退回
      // 「Date.now() + 10000」自己估 —— 用户反馈「刷新后没有倒计时」。
      if (c.status === 'betting') setPhase('betting', c.betEndAt);
      else if (c.status === 'locked' || c.status === 'betting-lock') setPhase('betting-lock', c.lockEndAt);
      else setPhase(c.status);
    }
    setBetBtn();
  }

  function onBegin(d) {
    cancelAnimationFrame(S.raf);
    S.round = d.gid; S.phase = 'betting'; S.hasBet = false; S.escDone = false;
    S.bets.clear();
    $('#betsList').innerHTML = '<div class="bets-empty">等待玩家下注…</div>';
    $('#jackpot').textContent = fmtC(d.jackpot || 0);
    $('#boomTxt').hidden = true;
    $('#multVal').className = 'val num';
    $('#multLbl').textContent = '';
    $('#multVal').textContent = '';
    // 复位火箭与爆炸特效
    var rk = $('#rocket'); if (rk) rk.hidden = true;
    var bx = $('#boomFx'); if (bx) bx.hidden = true;
    chart.reset();
    setPhase('betting', d.betEndAt);
    setBetBtn();
  }

  function onBet(d) {
    var id = String(d.memberid);
    if (S.bets.has(id)) return;
    S.bets.set(id, {
      id: id, name: d.nickname || '玩家', avatar: d.head_url,
      bet: d.bet, rate: 0, pnl: 0, win: false, lose: false, me: !!d.me,
    });
    renderBets();
    if (!d.me) beep(420 + Math.random() * 120, 0.05, 'triangle');
  }

  function onTakeoff(d) {
    S.phase = 'flying';
    S.flightMs = d.flightMs; S.flightStart = performance.now();
    S.lastTick = -1;
    $('#multLbl').textContent = '点击逃跑';
    setPhase('flying', d.flightMs);
    setBetBtn();
    sfxTakeoff();
    // 火箭：复刻原版 .rock —— 随曲线尖移动
    var rk = $('#rocket');
    if (rk) rk.hidden = false;
    var bx = $('#boomFx');
    if (bx) bx.hidden = true;
    tick();
  }

  /* ---------------- 火箭贴曲线 ---------------- */
  // rocket.png 是 128×128，火箭沿 45° 朝【右上】飞行。
  // 实测（alpha>128 的极值像素）：机头 (112,15)，机尾 (26,110)。
  // 按 CSS 固定显示尺寸 46px 归一化后，机尾在元素内的位置：
  //   TAIL_X = 26/128*46 = 9.34    TAIL_Y = 110/128*46 = 39.53
  // 锚点选【机尾】：曲线是火箭"拖"出来的，尾焰压在曲线尖上、
  // 机身朝斜上前方伸出，视觉上曲线才像被拖着走。
  //
  // ⚠️ 不要用 offsetWidth 换算：飞行帧里元素可能尚未完成布局（读到 0），
  //    `|| 46` 兜底会让比例悄悄错掉。尺寸既然由 CSS 固定，这里就用常量，
  //    两者必须同源（改 CSS 尺寸就同步改这里）。
  var ROCKET_PX = 46;
  var TAIL_X = 9.34;
  var TAIL_Y = 39.53;

  function tick() {
    cancelAnimationFrame(S.raf);
    var loop = function () {
      if (S.phase !== 'flying') return;
      if (window.__hold) { S.raf = requestAnimationFrame(loop); return; }   // 调试定格
      var el = performance.now() - S.flightStart;
      var SCALE = S.cfg.flightScale || 2.5;
      // 真实秒数 = 曲线参数 t × SCALE
      var sec = el / 1000;
      var t = sec / SCALE;
      var rate = t / 2 + (t * t - t) / 10 + 1;
      $('#multVal').textContent = rate.toFixed(2);
      if (rate >= 5) $('#multVal').className = 'val num hot';
      if (chart) chart.setState({ status: 'flying', sec: sec, rate: rate, scale: SCALE });
      // 火箭贴在曲线尖端（用 chart 暴露的绘图区几何精确定位）
      if (chart && chart.plot) {
        var P = chart.plot;
        var rkEl = $('#rocket');
        if (rkEl) {
          // 尾部锚点定在曲线尖上，机身沿 45° 斜向前方伸出。
          // 尺寸用 CSS 常量（ROCKET_PX），不读 offsetWidth —— 见上方注释。
          var kx = TAIL_X * (ROCKET_PX / 46);
          var ky = TAIL_Y * (ROCKET_PX / 46);
          rkEl.style.left = (P.xFor(sec) - kx) + 'px';
          rkEl.style.top = (P.yFor(rate) - ky) + 'px';
          rkEl.style.right = 'auto';
        }
      }
      // 倍率每跨过 0.5 就滴一声，倍率越高越密
      var step = Math.floor(rate * 2);
      if (step !== S.lastTick) { S.lastTick = step; if (rate > 1.05) sfxTick(rate); }
      // 【不要显示剩余秒数】flightMs 是服务端算出的完整飞行时长，
      // 「还有 N 秒爆炸」会直接暴露最终倍率 —— rate = f(flightMs)，
      // 玩家拿秒数反推就知道这一局是几倍，等于开卷考试。
      // 飞行中只显示实时倍率，不透露任何剩余时间。
      $('#phase').innerHTML = '飞行中 · 倍率 <b>' + rate.toFixed(2) + 'x</b> · 点击逃跑';
      S.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function onEscape(d) {
    var id = String(d.uid);
    var row = S.bets.get(id);
    if (!row) { row = { id: id, name: d.user_name, avatar: d.head_url, bet: d.bet || 0, me: !!d.me }; S.bets.set(id, row); }
    row.rate = d.escape; row.win = true; row.me = !!d.me;
    row.pnl = d.profit != null ? d.profit : (d.escape * (d.bet || 0));
    if (d.me) {
      S.escDone = true;
      setBetBtn();
      if (d.balance != null) setCoins(d.balance);
      toast('逃跑成功！+' + fmtC(row.pnl) + ' QUN', 'ok');
      sfxEscape(Number(d.escape));
    } else {
      floatUp(row.name + ' @' + Number(d.escape).toFixed(2) + 'x');
    }
    renderBets();
  }

  function onOver(d) {
    cancelAnimationFrame(S.raf);
    S.phase = 'over';
    var boom = d.boom;
    S.boomRate = boom;
    $('#boomTxt').hidden = false;
    $('#boomRate').textContent = Number(boom).toFixed(2) + 'x';
    $('#multVal').textContent = Number(boom).toFixed(2);
    $('#multVal').className = 'val num crash';
    $('#multLbl').textContent = '本局结束';
    $('#phase').textContent = '下一局准备中…';
    if (chart) chart.setState({ status: 'over', sec: (S.flightMs || 0) / 1000, rate: Number(d.boom) || 0, scale: S.cfg.flightScale || 2.5, boom: Number(d.boom) || 0 });
    if (d.jackpot != null) $('#jackpot').textContent = fmtC(d.jackpot);
    sfxBoom();
    sfxResult(!!S.escDone);      // 赢了走扬调，输了走降调
    document.querySelector('.stage').style.animation = 'shake .4s';

    // 爆炸特效：原版 rocket_boom.jpg 炸开后 2s 隐藏（isExplosion 的 setTimeout 2000）
    var rk = $('#rocket');
    if (rk) rk.hidden = true;
    var bx = $('#boomFx');
    if (bx) {
      bx.hidden = false;
      // 重置动画：先置 none 再强制回流，确保每次爆炸都重新播放
      var bimg = bx.querySelector('img');
      if (bimg) { bimg.style.animation = 'none'; void bimg.offsetWidth; bimg.style.animation = ''; }
      setTimeout(function () { bx.hidden = true; }, 2000);
    }

    // 标记输家
    S.bets.forEach(function (r) {
      if (!r.win) { r.lose = true; r.pnl = -r.bet; }
    });
    // 输的玩家金币退回已在服务端完成，这里刷新自己的余额
    if (S.me) api('/api/me').then(function (r) { if (r.j.user) { S.me = r.j.user; renderMe(); } });
    renderBets();
    S.history.unshift({ gid: d.gid, boom: boom });
    if (S.history.length > 20) S.history.pop();
    renderHistory();
    setBetBtn();
  }

  /* ---------------- 渲染 ---------------- */
  /**
   * 增量更新下注列表。
   * 原实现每次消息都 innerHTML 重建整张表 → 每条消息都闪一次。
   * 现在按 data-id 复用已有行，只改变化的单元格；新下注才追加新行。
   */
  function renderBets() {
    var box = $('#betsList');
    var list = Array.from(S.bets.values());
    if (!list.length) {
      if (!box.querySelector('.bets-empty')) box.innerHTML = '<div class="bets-empty">等待玩家下注…</div>';
      return;
    }
    var empty = box.querySelector('.bets-empty');
    if (empty) empty.remove();

    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var id = 'bet-' + String(r.id).replace(/[^\w-]/g, '');
      var row = box.querySelector('#' + id);
      var rate = r.rate ? Number(r.rate).toFixed(2) + 'x' : '—';
      var pnl = r.win ? '+' + fmtC(r.pnl) : (r.lose ? '-' + fmtC(r.bet) : '—');
      var cls = 'bets-row' + (r.win ? ' win' : '') + (r.lose ? ' lose' : '') + (r.me ? ' me' : '');

      if (!row) {
        // 新行：只追加，不动已有行
        var el = document.createElement('div');
        el.id = id;
        el.className = cls;
        el.innerHTML = '<div class="who"><img src="' + esc(r.avatar || '/assets/robot.svg') + '" alt=""><span>' + esc(r.name) + '</span></div>'
          + '<div class="num rate">—</div>'
          + '<div class="num">' + fmtC(r.bet) + '</div>'
          + '<div class="num pnl">—</div>';
        box.appendChild(el);
        row = el;
      } else if (row.className !== cls) {
        row.className = cls;
      }

      // 只在值真的变了才写 DOM
      var cells = row.children;
      if (cells[1] && cells[1].textContent !== rate) cells[1].textContent = rate;
      if (cells[3] && cells[3].textContent !== pnl) cells[3].textContent = pnl;
    }
  }

  function renderHistory() {
    var box = $('#history');
    if (!S.history.length) { box.innerHTML = '<div class="bets-empty">暂无记录</div>'; return; }
    var html = '';
    for (var i = 0; i < S.history.length; i++) {
      var h = S.history[i];
      var low = h.boom < 1.5;
      html += '<div class="lrow" style="padding:9px 6px">'
        + '<div class="t"><b>#' + h.gid + '</b><small>爆点</small></div>'
        + '<div class="r"><b class="' + (low ? 'neg' : 'pos') + '">' + Number(h.boom).toFixed(2) + 'x</b></div>'
        + '</div>';
    }
    box.innerHTML = html;
  }

  function floatUp(text) {
    var f = document.createElement('div');
    f.className = 'float';
    f.textContent = text;
    f.style.left = (20 + Math.random() * 60) + '%';
    $('#floats').appendChild(f);
    setTimeout(function () { f.remove(); }, 2200);
  }

  /**
   * 阶段切换 + 倒计时。
   *
   * 【为什么必须用服务端绝对时间】之前是「拿到 betMs 就自己 setInterval 递减」，
   * 而服务端实际时长 = 机器人推送耗时 + 补足 sleep，两者对不上，
   * 于是倒计时会多出 3 秒左右（用户反馈"还有3秒就开始了"）。
   * 现在服务端下发 betEndAt / lockEndAt（服务端时钟），
   * 前端用「截止时间 - 本地时钟 + 时钟偏移」算剩余时间，误差不会累积。
   */
  function setPhase(ph, endAt) {
    S.phase = ph;
    var el = $('#phase');
    if (S.betT) { clearInterval(S.betT); S.betT = null; }
    if (ph === 'betting' || ph === 'betting-lock' || ph === 'locked') {
      var end = endAt || (Date.now() + (S.cfg.betMs || 10000));
      var locked = (ph !== 'betting');
      var tick = function () {
        var left = (end - S.now()) / 1000;
        if (left <= 0) {
          clearInterval(S.betT); S.betT = null;
          if (!locked) { el.textContent = '封盘中…等待发射'; setPhase('betting-lock'); }
          return;
        }
        el.innerHTML = locked
          ? '<b>' + left.toFixed(1) + 's</b> 后起飞 · 已封盘'
          : '<b>' + left.toFixed(1) + 's</b> 后封盘 · 点击下注';
      };
      tick();
      S.betT = setInterval(tick, 100);
      setBetBtn();
    } else if (ph === 'flying') {
      el.textContent = '飞行中 · 点击逃跑';
    }
  }

  /**
   * 服务端时钟（毫秒）。
   * 客户端和服务器可能有几秒偏差，所以用「响应到达时的往返耗时」估算偏移，
   * 让倒计时跟服务端节奏一致，而不是各自本地时钟各走各的。
   */
  S.clockOffset = 0;
  S.now = function () { return Date.now() + S.clockOffset; };
  function syncClock() {
    var t0 = Date.now();
    fetch('/api/me', { credentials: 'same-origin' }).then(function (r) {
      var t1 = Date.now();
      try { r.json(); } catch (_) {}
      S.clockOffset = Date.now() - (t0 + t1) / 2;
    }).catch(function () {});
  }

  function setBetBtn() {
    var b = $('#actBtn');
    b.className = 'btn btn-lg act-btn ';
    if (!S.me) { b.textContent = '请先登录'; b.disabled = true; return; }
    if (S.escDone) { b.textContent = '已逃跑 ✓'; b.disabled = true; b.className += 'done'; return; }
    // 飞行中：只有【自己下注了】才能逃 —— 黄色可点。
    // 没下注就是灰色禁用，按钮写「未下注」，不给可以点的假希望。
    if (S.phase === 'flying') {
      if (S.hasBet) { b.textContent = '逃跑！'; b.disabled = false; b.className += 'cash'; }
      else { b.textContent = '未下注'; b.disabled = true; b.className += 'wait'; }
      return;
    }
    if (S.phase === 'over' || S.phase === 'idle') { b.textContent = '等待下一局'; b.disabled = true; b.className += 'wait'; return; }
    // 【关键】封盘期必须禁用下注。之前只判 S.phase，导致 betting-lock 阶段还能点。
    if (S.phase === 'betting-lock' || S.phase === 'locked') { b.textContent = '已封盘'; b.disabled = true; b.className += 'wait'; return; }
    b.textContent = '下注 ' + fmt(S.bet) + ' QUN';
    b.disabled = false; b.className += 'bet';
  }

  /* ---------------- 操作 ---------------- */
  function setBet(v) {
    S.bet = Math.max(1, Math.min(999999, Math.round(v)));
    var inp = $('#betAmt');
    // 输入框正在被用户编辑时不要回写，否则光标会跳到末尾、打字会很难受。
    if (inp && document.activeElement !== inp) {
      inp.value = String(S.bet);
    }
    setBetBtn();
  }
  // 手动输入：只收数字，去掉逗号和空白。
  // 边打边把非法字符从框里剔掉（而不是只在状态里忽略），
  // 否则用户会看到自己打的 'abc' 留在输入框里，但按钮显示 1.00，很困惑。
  $('#betAmt').addEventListener('input', function (e) {
    var el = e.target;
    var raw = String(el.value).replace(/[^\d]/g, '');
    if (raw !== el.value) {
      var atEnd = el.selectionStart === el.value.length;
      el.value = raw;
      if (atEnd) { try { el.setSelectionRange(raw.length, raw.length); } catch (_) {} }
    }
    var n = Math.max(1, Math.min(999999, parseInt(raw, 10) || 1));
    S.bet = n;
    setBetBtn();
  });
  // 失焦时把规范化后的值写回（清掉多余前导零等）
  $('#betAmt').addEventListener('blur', function (e) { setBet(S.bet); });
  $('#minus').onclick = function () { setBet(S.bet <= 10 ? 1 : S.bet - (S.bet > 100 ? 10 : 1)); };
  $('#plus').onclick = function () { setBet(S.bet + (S.bet >= 100 ? 10 : 1)); };
  $('#btnMin').onclick = function () { setBet(1); };
  $('#btnMax').onclick = function () { if (S.me) setBet(Math.max(1, Math.floor(S.me.coins))); };
  // 两个独立开关：🎵 背景音乐 / 🔊 音效（互不影响）
  // 用 localStorage 记住选择，刷新后不再被重置为默认开启
  function loadSoundPref() {
    try {
      var v = localStorage.getItem('bd_sound');
      if (v == null) return;                 // 没存过 → 保持默认（都开）
      S.bgmOn = (v !== 'bgm0' && v !== 'both0');
      S.sfxOn = (v !== 'sfx0' && v !== 'both0');
    } catch (_) {}
  }
  function saveSoundPref() {
    try {
      var v = (!S.bgmOn && !S.sfxOn) ? 'both0' : (!S.bgmOn ? 'bgm0' : (!S.sfxOn ? 'sfx0' : 'on'));
      localStorage.setItem('bd_sound', v);
    } catch (_) {}
  }
  function paintSoundBtns() {
    var b1 = $('#btnBgm'), b2 = $('#btnSfx');
    if (b1) { b1.textContent = S.bgmOn ? '🎵' : '🔕'; b1.style.opacity = S.bgmOn ? '1' : '.45'; }
    if (b2) { b2.textContent = S.sfxOn ? '🔊' : '🔇'; b2.style.opacity = S.sfxOn ? '1' : '.45'; }
  }
  $('#btnBgm').onclick = function () {
    S.bgmOn = !S.bgmOn;
    saveSoundPref(); paintSoundBtns();
    if (S.bgmOn) { initAudio(); playBgm(); } else stopBgm();
  };
  $('#btnSfx').onclick = function () {
    S.sfxOn = !S.sfxOn;
    saveSoundPref(); paintSoundBtns();
    if (S.sfxOn) { initAudio(); beep(880, 0.08); }   // 给个反馈
  };
  // 音频解锁：必须由真实用户手势触发（浏览器策略），成功一次后解绑
  ['pointerdown', 'click', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function onFirst() {
      tryUnlockAudio();
      if (audioUnlocked) document.removeEventListener(ev, onFirst, true);
    }, true);
  });

  // 弹幕输入
  $('#chatForm').onsubmit = function (e) { e.preventDefault(); sendChat(); };

  $('#actBtn').onclick = function () {
    if (!S.me || !S.round) return;
    if (S.hasBet && S.phase === 'flying') {
      this.disabled = true;
      api('/api/game/escape', { method: 'POST', body: { roundId: S.round } }).then(function (r) {
        if (!r.ok) { toast(r.j.error || '逃跑失败', 'err'); this.disabled = false; }
        else { S.escDone = true; setBetBtn(); }
      }.bind(this));
    } else {
      if (S.me.coins < S.bet) { toast('QUN 不足，去签到领一些吧', 'err'); return; }
      this.disabled = true;
      api('/api/game/bet', { method: 'POST', body: { roundId: S.round, amount: S.bet } }).then(function (r) {
        if (!r.ok) { toast(r.j.error || '下注失败', 'err'); }
        else { S.hasBet = true; sfxBet(); if (r.j.balance != null) setCoins(r.j.balance); }
        setBetBtn();
      });
    }
  };

  /* ---------------- 面板 ---------------- */
  function sheet(title, html) {
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheet').hidden = false;
  }
  function closeSheet() { $('#sheet').hidden = true; }
  $('#sheetClose').onclick = closeSheet;
  $('#sheet').onclick = function (e) { if (e.target === this) closeSheet(); };

  /* ---------------- 标签页 ---------------- */
  $$('.tab').forEach(function (t) {
    t.onclick = function () {
      $$('.tab').forEach(function (x) { x.classList.remove('on'); });
      t.classList.add('on');
      showTab(t.dataset.tab);
    };
  });

  function showTab(tab) {
    if (tab === 'game') { closeSheet(); return; }
    if (tab === 'rank') return loadRank();
    if (tab === 'invite') return loadInvite();
    if (tab === 'me') return loadMe();
  }

  function loadRank() {
    sheet('排行榜', '<div class="bets-empty">加载中…</div>');
    api('/api/leaderboard').then(function (r) {
      if (!r.j.list || !r.j.list.length) { sheet('排行榜', '<div class="bets-empty">还没有人下注，快来当第一个！</div>'); return; }
      var html = '';
      for (var i = 0; i < r.j.list.length; i++) {
        var u = r.j.list[i];
        var medal = ['🥇', '🥈', '🥉'][i] || ('<span class="mono" style="color:var(--fg-3)">' + (i + 1) + '</span>');
        html += '<div class="lrow">'
          + '<div style="width:26px;text-align:center;font-size:16px">' + medal + '</div>'
          + '<img src="' + esc(avatar(u)) + '" alt="">'
          + '<div class="t"><b>' + esc(u.name) + '</b><small>' + u.bets + ' 局</small></div>'
          + '<div class="r"><b>' + fmtC(u.coins) + '</b><small>QUN 余额</small></div>'
          + '</div>';
      }
      sheet('排行榜 · QUN 余额', html);
    });
  }

  function loadInvite() {
    sheet('邀请好友', '<div class="bets-empty">加载中…</div>');
    api('/api/invite').then(function (r) {
      if (!r.ok) { sheet('邀请好友', '<div class="bets-empty">' + esc(r.j.error || '加载失败') + '</div>'); return; }
      var link = location.origin + '/?invite=' + r.j.code;
      var html = '<div class="invite-code"><span class="digits">' + esc(r.j.code) + '</span></div>'
        + '<div class="inv-share">'
        + '<button class="btn" data-share="discord"><span class="ic">💬</span>Discord</button>'
        + '<button class="btn" data-share="copy"><span class="ic">📋</span>复制链接</button>'
        + '<button class="btn" data-share="qr"><span class="ic">🔳</span>二维码</button>'
        + '<button class="btn" data-share="navigator"><span class="ic">📤</span>分享</button>'
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 2px;border-top:1px solid var(--stroke)">'
        + '<span style="font-size:13.5px;color:var(--fg-2)">已获得奖励</span>'
        + '<b class="num" style="color:var(--qun)">+' + fmtC(r.j.totalEarned) + ' QUN</b></div>';
      if (r.j.invitees.length) {
        html += '<div style="margin-top:8px">';
        for (var i = 0; i < r.j.invitees.length; i++) {
          var v = r.j.invitees[i];
          html += '<div class="lrow"><img src="' + esc(avatar(v)) + '" alt="">'
            + '<div class="t"><b>' + esc(v.name) + '</b><small>' + v.rounds + ' 局 · ' + (v.rewarded ? '已奖励' : '需 ' + r.j.minRounds + ' 局') + '</small></div>'
            + '<div class="r"><b class="' + (v.rewarded ? 'pos' : '') + '">' + (v.rewarded ? '✓' : '…') + '</b></div></div>';
        }
        html += '</div>';
      }
      html += '<div class="note">好友通过你的链接首次登录，且累计参与 <b>' + r.j.minRounds + '</b> 局后，你即可获得 <b>' + fmt(r.j.reward) + ' QUN</b> 奖励。</div>';
      sheet('邀请好友得 QUN', html);

      $$('[data-share]', $('#sheetBody')).forEach(function (b) {
        b.onclick = function () { share(b.dataset.share, link, r.j.code); };
      });
      if (r.j.totalEarned) { setCoins(S.me.coins + 0); }
      api('/api/me').then(function (x) { if (x.j.user) { S.me = x.j.user; renderMe(); } });
    });
  }

  function share(kind, link, code) {
    if (kind === 'copy') {
      navigator.clipboard.writeText(link).then(function () { toast('已复制邀请链接', 'ok'); });
    } else if (kind === 'navigator') {
      if (navigator.share) navigator.share({ title: '爆点逃跑', text: '来玩爆点逃跑，一起赚 QUN！', url: link });
      else navigator.clipboard.writeText(link).then(function () { toast('已复制邀请链接', 'ok'); });
    } else if (kind === 'discord' && sdk) {
      sdk.commands.shareLink({ content: '来玩爆点逃跑，赢 QUN！' }).then(function () { toast('已打开分享', 'ok'); })
        .catch(function () { navigator.clipboard.writeText(link); toast('已复制邀请链接', 'ok'); });
    } else if (kind === 'qr') {
      showQR(link);
    }
  }

  function showQR(link) {
    // 轻量 QR（复用后端生成的 SVG 不便，这里用在线图表太重 -> 简化为提示）
    sheet('邀请二维码', '<div style="text-align:center;padding:20px">'
      + '<div class="invite-code" style="margin-bottom:16px"><span class="digits">' + esc(qs('invite') || (S.me && S.me.discordId) || '') + '</span></div>'
      + '<p style="color:var(--fg-2);font-size:14px;margin-bottom:12px">在 Discord 内输入你的邀请码，或复制链接发给好友</p>'
      + '<button class="btn btn-primary btn-block" id="qrCopy">复制邀请链接</button></div>');
    $('#qrCopy').onclick = function () { navigator.clipboard.writeText(link).then(function () { toast('已复制', 'ok'); }); };
  }

  function loadMe() {
    sheet('我的', '<div class="bets-empty">加载中…</div>');
    api('/api/game/history').then(function (r) {
      var rows = (r.j && r.j.list) || [];
      var total = 0, wins = 0;
      for (var i = 0; i < rows.length; i++) { total += rows[i].profit || 0; if (rows[i].status === 1) wins++; }
      var html = '';
      html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:16px">'
        + statCard(fmtC(S.me.coins), 'QUN 余额')
        + statCard(String(rows.length), '总下注局数')
        + statCard((total >= 0 ? '+' : '') + fmtC(total), '累计盈亏', total >= 0 ? 'pos' : 'neg')
        + '</div>';
      html += '<button class="btn btn-qun btn-block btn-lg" id="btnCheckin" style="margin-bottom:10px">'
        + '<img class="qun-ic" src="/assets/qun.png" alt=""> 每日签到 +' + (S.cfg.checkinCoins || 100) + ' QUN</button>';
      html += '<button class="btn btn-block btn-lg" id="btnTransfer" style="margin-bottom:16px">💸 转账 QUN</button>';
      html += '<button class="btn btn-block" id="btnLogout" style="margin-bottom:16px;color:var(--fg-3)">退出登录</button>';
      html += '<div style="font-weight:700;font-size:14px;margin-bottom:6px">最近战绩</div>';
      if (!rows.length) html += '<div class="bets-empty">还没有下注记录</div>';
      for (var i = 0; i < Math.min(rows.length, 30); i++) {
        var b = rows[i];
        var win = b.status === 1;
        html += '<div class="lrow"><div class="t"><b>#' + b.round_id + ' ' + (win ? '逃跑' : '爆掉') + '</b>'
          + '<small>' + esc(b.created_at) + '</small></div>'
          + '<div class="r"><b class="' + (b.profit >= 0 ? 'pos' : 'neg') + '">' + (b.profit >= 0 ? '+' : '') + fmtC(b.profit) + '</b>'
          + '<small>投入 ' + fmtC(b.amount) + (b.escape_rate ? ' @' + Number(b.escape_rate).toFixed(2) + 'x' : '') + '</small></div></div>';
      }
      sheet('我的', html);

      $('#btnCheckin').onclick = function () {
        api('/api/checkin', { method: 'POST', body: {} }).then(function (x) {
          if (x.ok) { toast('签到成功 +' + fmt(x.j.amount) + ' QUN', 'ok'); setCoins(x.j.balance); loadMe(); }
          else toast(x.j.error || '签到失败', 'err');
        });
      };
      $('#btnLogout').onclick = function () {
        api('/api/auth/logout', { method: 'POST', body: {} }).then(function () { location.reload(); });
      };
      $('#btnTransfer').onclick = openTransfer;
    });
  }

  /* ---------------- 转账 ---------------- */

  var tState = { to: '', name: '', avatar: '', amount: '' };

  function openTransfer() {
    tState = { to: '', name: '', avatar: '', amount: '' };
    renderTransfer();
  }

  function renderTransfer() {
    var picked = tState.to && tState.name;
    var html = '';

    if (picked) {
      // 已选收款方：卡片 + 金额
      html += '<div class="tf-pick">'
        + '<img src="' + esc(tState.avatar || '/assets/avatar-default.svg') + '" alt="">'
        + '<div class="tf-pick-t"><b>' + esc(tState.name) + '</b><small>转给 ' + esc(tState.to) + '</small></div>'
        + '<button class="btn btn-sm" id="tfClear">更换</button>'
        + '</div>';

      html += '<div class="fl">'
        + '<label for="tfAmt">转账金额</label>'
        + '<div class="fl-box amt">'
        + '<input id="tfAmt" type="number" inputmode="decimal" min="1" step="1" placeholder="0" value="' + esc(tState.amount) + '">'
        + '<span class="fl-unit"><img src="/assets/qun.png" alt="">QUN</span>'
        + '</div>'
        + '<div class="fl-hint">你的余额 <b class="num">' + fmt(S.me.coins) + '</b> QUN</div>'
        + '</div>';

      html += '<div class="fl-quick">'
        + [10, 50, 100, 500].map(function (v) {
          return '<button class="btn" data-quick="' + v + '">' + v + '</button>';
        }).join('')
        + '</div>';

      html += '<button class="btn btn-qun btn-block btn-lg" id="tfGo">确认转账</button>';
      html += '<div class="fl-err" id="tfErr" hidden></div>';
    } else {
      // 未选：搜索
      html += '<div class="fl">'
        + '<label for="tfTo">收款方</label>'
        + '<div class="fl-box">'
        + '<span class="fl-ico">🔍</span>'
        + '<input id="tfTo" placeholder="输入昵称或 Discord ID" value="' + esc(tState.to) + '" autocomplete="off">'
        + '</div>'
        + '<div class="fl-hint">支持按昵称或 Discord ID 搜索，点击结果即可选中</div>'
        + '</div>';
      html += '<div id="tfResults"></div>';
    }

    html += '<div class="tf-sep">最近转账</div>';
    html += '<div id="tfHist"><div class="bets-empty">加载中…</div></div>';
    sheet('转账', html);

    /* ---- 事件绑定 ---- */
    var cc = $('#tfClear');
    if (cc) cc.onclick = function () {
      tState.to = ''; tState.name = ''; tState.avatar = ''; tState.amount = '';
      renderTransfer();
    };

    var amt = $('#tfAmt');
    if (amt) {
      amt.oninput = function () { tState.amount = amt.value; hideErr(); };
      // 移动端数字键盘直接弹
      amt.onfocus = function () { setTimeout(function () { amt.select(); }, 60); };
    }
    [].forEach.call(document.querySelectorAll('[data-quick]'), function (b) {
      b.onclick = function () {
        tState.amount = b.getAttribute('data-quick');
        var a = $('#tfAmt'); if (a) a.value = tState.amount;
        hideErr();
      };
    });
    var go = $('#tfGo');
    if (go) go.onclick = doTransfer;

    var to = $('#tfTo');
    if (to) {
      var t = null;
      to.oninput = function () {
        clearTimeout(t);
        var q = to.value.trim();
        tState.to = q;
        if (q.length < 1) { $('#tfResults').innerHTML = ''; return; }
        t = setTimeout(function () {
          api('/api/users/search?q=' + encodeURIComponent(q)).then(function (r) {
            var list = (r.j && r.j.list) || [];
            if (!list.length) {
              $('#tfResults').innerHTML = '<div class="bets-empty" style="padding:10px">没有找到用户</div>';
              return;
            }
            $('#tfResults').innerHTML = '<div class="fl-pop">'
              + list.slice(0, 6).map(function (u) {
                return '<div class="lrow" data-pick="' + esc(u.discordId) + '" data-name="' + esc(u.name) + '" data-av="' + esc(avatar(u)) + '">'
                  + '<img src="' + esc(avatar(u)) + '" alt="">'
                  + '<div class="t"><b>' + esc(u.name) + '</b><small>' + esc(u.discordId) + '</small></div>'
                  + '<div class="r"><b>' + fmt(u.coins) + '</b><small>QUN</small></div>'
                  + '</div>';
              }).join('')
              + '</div>';
            [].forEach.call($('#tfResults').querySelectorAll('[data-pick]'), function (el) {
              el.onclick = function () {
                tState.to = el.getAttribute('data-pick');
                tState.name = el.getAttribute('data-name');
                tState.avatar = el.getAttribute('data-av');
                renderTransfer();
              };
            });
          });
        }, 250);
      };
    }

    api('/api/transfer/history?limit=10').then(function (r) {
      var list = (r.j && r.j.list) || [];
      if (!$('#tfHist')) return;
      if (!list.length) { $('#tfHist').innerHTML = '<div class="bets-empty">还没有转账记录</div>'; return; }
      $('#tfHist').innerHTML = list.map(function (t) {
        var out = t.reason === 'transfer_out';
        return '<div class="lrow"><div class="t"><b>' + (out ? '转给 ' : '来自 ') + esc(t.peerName || '?') + '</b>'
          + '<small>' + esc(t.at) + '</small></div>'
          + '<div class="r"><b class="' + (out ? 'neg' : 'pos') + '">' + (out ? '−' : '+') + fmt(Math.abs(t.delta)) + '</b>'
          + '<small>' + fmt(t.balance) + '</small></div></div>';
      }).join('');
    });

    function hideErr() {
      var e = $('#tfErr');
      if (e) { e.hidden = true; e.textContent = ''; }
      var b = $('#tfGo');
      if (b) { b.disabled = false; b.textContent = '确认转账'; }
    }
  }

  function doTransfer() {
    var amt = Number(tState.amount);
    var err = $('#tfErr');
    function fail(msg) {
      if (err) { err.textContent = msg; err.hidden = false; }
      else toast(msg, 'err');
    }
    if (!(amt > 0)) return fail('请输入转账金额');
    if (amt > (S.me && S.me.coins || 0)) return fail('余额不足，你只有 ' + fmt(S.me.coins) + ' QUN');

    var btn = $('#tfGo');
    if (btn) { btn.disabled = true; btn.textContent = '转账中…'; }
    api('/api/transfer', { method: 'POST', body: { to: tState.to, amount: amt } }).then(function (r) {
      if (r.j && r.j.ok) {
        toast('已转出 ' + fmt(r.j.amount) + ' QUN', 'ok');
        setCoins(r.j.myBalance);
        tState.to = ''; tState.name = ''; tState.avatar = ''; tState.amount = '';
        renderTransfer();
      } else {
        fail((r.j && r.j.error) || '转账失败');
        if (btn) { btn.disabled = false; btn.textContent = '确认转账'; }
      }
    });
  }
  function statCard(v, l, cls) {
    return '<div class="glass" style="padding:12px 8px;text-align:center">'
      + '<div class="num ' + (cls || '') + '" style="font-size:19px;font-weight:800">' + v + '</div>'
      + '<div style="font-size:11.5px;color:var(--fg-3);margin-top:3px">' + l + '</div></div>';
  }

  /* ---------------- 登录按钮 ---------------- */
  $('#btnDiscord').onclick = login;

  /* ---------------- 初始化 ---------------- */
  loadSoundPref();
  paintSoundBtns();
  syncClock();
  api('/api/me').then(function (r) {
    if (r.j && r.j.discord) window.__DC_ID = r.j.discord.clientId;
    loadChatHistory();     // 载入服务器保留的聊天记录
    // chart 不在这里 new —— #app 可能还是 hidden，量不到尺寸。改由 start() 负责。

    if (r.j && r.j.user) {
      S.me = r.j.user; S.cfg = r.j.config || {};
      start();
      return;
    }

    // ── 未登录：小游戏内【自动登录】，不要求玩家点按钮 ──
    // 在 Activity（discord.com）里，Discord 已经在 iframe 中完成过用户授权，
    // prompt:'none' 的静默换票几乎必然成功。原来的做法是弹登录页等点击，
    // 玩家进游戏先看到一屏按钮 —— 而且如果外层/内层都触发一次 login()，
    // 就会发出两次 authorize + 两次 /api/auth/discord，即「重复请求」。
    // 这里用 S.logging 作单一守卫，保证整个生命周期最多跑一轮。
    if (inDiscord()) {
      $('#authMsg').textContent = '正在通过 Discord 登录…';
      runLoginOnce();
      return;
    }

    // 独立网页版：OAuth2 需要一次真实跳转，无法静默完成，保留按钮
    $('#auth').hidden = false;
  });

})();
