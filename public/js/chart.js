/**
 * 爆点曲线 —— 手写 Canvas，严格复刻原版 echarts 配置
 *
 * 原版配置来源（public/static/index/js/index-index.js 第 209-304 行）：
 *   grid:        { top:'15%', left:'3%', right:'4%', bottom:'5%', containLabel:true }
 *   xAxis:       type value, boundaryGap:false, axisLine #464F6A,
 *                max = max(10, 数据最大秒数), axisTick/axisLabel inside:true,
 *                formatter:'{value}s', showMinLabel:false, showMaxLabel:false,
 *                fontSize:9, splitLine:{show:false}
 *   yAxis:       type value, scale:true, min:1, max = max(4.5, 数据最大倍率),
 *                axisLine #464F6A, formatter:'{value}x', splitLine:{show:false}
 *   series:      type line, showSymbol:false, itemStyle cornflowerblue,
 *                areaStyle 线性渐变 rgba(255,255,255,.3) → rgba(255,255,255,.05)
 *
 * 两个关键点（之前做错过）：
 *  1. **线性轴，不是对数轴。** 原版 yAxis 用 `scale:true` + 动态 max(4.5, data.max)，
 *     所以低倍率段是拉开的，高倍率会把整条曲线压扁 —— 这就是原版的样子。
 *  2. **横轴是秒数，标签形如 "1.2s"。** 数据点 value:[秒, 倍率]，每 100ms 推一个。
 *     上限 max(10, 已飞秒数) 意味着坐标轴随飞行向右「长」，但至少留 10 秒。
 *
 * 火箭不在 canvas 里画：原版 `.rock` 是 DOM 元素，绝对定位在图表容器右上角
 * （right:-.25rem; top:-.025rem; animation:animateRock），随曲线上升在视觉上居中。
 */
(function (global) {
  'use strict';

  var AXIS = '#464F6A';        // 原版 axisLine.lineStyle.color
  var GRID = '#303542';        // 原版 splitLine.lineStyle.color（但 show:false）
  var LINE = '#6495ED';        // cornflowerblue = 实际的 #6495ED
  var X_FLOOR = 10;            // 原版 xAxis.max 初始值（秒）
  var Y_FLOOR = 4.5;           // 原版 yAxis.max 初始值（倍率）
  var STEP_MS = 100;           // 原版 setInterval(…, 100)

  function BoomChart(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(global.devicePixelRatio || 1, 3);
    this.status = 'preview';   // preview | flying | over
    this.samples = [];         // [{sec, rate}]
    this.boom = null;
    this.scale = 2.5;          // 飞行缩放（与服务端 FLIGHT_SCALE 一致）
    this.resize();
  }

  BoomChart.prototype.resize = function () {
    var r = this.c.getBoundingClientRect();
    // 容器还没布局（hidden / display:none）时量到 0×0。
    // 以前这里直接 return，于是 canvas 停在默认 300×150 被 CSS 拉伸成
    // 模糊的 564×300，this.w/h/plot 永远不建立 → 坐标轴不画、火箭无定位依据。
    // 改成记一个 pending 标志，元素可见后由 retry() 补一次。
    if (!r.width || !r.height) { this.pending = true; return; }
    this.pending = false;
    this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width * this.dpr);
    this.c.height = Math.round(r.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  };

  /** 若之前因不可见而未能初始化，元素可见后调用一次。 */
  BoomChart.prototype.retry = function () {
    if (this.pending) this.resize();
  };

  BoomChart.prototype.preview = function () { this.status = 'preview'; this.draw(); };
  BoomChart.prototype.reset = function () { this.status = 'preview'; this.samples = []; this.boom = null; this.draw(); };

  /**
   * 每帧调用。sec = 已飞行秒数（真实时间），rate = 对应倍率。
   * 按原版节奏补齐采样点：每 STEP_MS 一个点。
   */
  BoomChart.prototype.setState = function (st) {
    // 自愈：容器曾经不可见导致 resize() 空转过时，这里补一次，
    // 免得「画不出坐标轴 + 火箭没有定位基准」要等人工排查。
    if (this.pending) this.retry();
    if (st.scale) this.scale = st.scale;
    if (st.status) this.status = st.status;
    if (st.status === 'flying' || st.status === 'over') {
      var want = Math.max(1, Math.round((st.sec * 1000) / STEP_MS));
      while (this.samples.length < want) {
        // 补齐中间点：用公式反算，保证曲线连续（等价原版的 flag 累加）
        var i = this.samples.length;
        var t = (i * STEP_MS) / 1000 / this.scale;
        this.samples.push({ sec: i * STEP_MS / 1000, rate: t / 2 + (t * t - t) / 10 + 1 });
      }
      if (this.samples.length > want + 2) this.samples.length = want + 2;
    }
    if (st.boom != null) this.boom = st.boom;
    this.draw();
  };

  BoomChart.prototype.draw = function () {
    var ctx = this.ctx, w = this.w, h = this.h;
    if (!w || !h) return;

    var fam = getComputedStyle(document.body).fontFamily;
    var i;

    // grid: top 15% / left 3% / right 4% / bottom 5%（containLabel → 左侧留字宽）
    var padT = Math.round(h * 0.15);
    var padB = Math.round(h * 0.05);
    var padL = Math.round(w * 0.03) + 22;   // containLabel：给 "1000x" 留位
    var padR = Math.round(w * 0.04);
    var gw = w - padL - padR, gh = h - padT - padB;
    if (gw <= 0 || gh <= 0) return;

    var S = this.samples;
    var last = S.length ? S[S.length - 1] : null;

    // ---------- 动态轴上限 ----------
    // 原版是 max: function(value){ return max(初始值, value.max) } —— 直接用数据最大值，
    // 所以坐标轴随曲线【连续平滑地长】，不是卡在 1/2/5/10 几个档位上跳变。
    // 之前用 niceCeil() 取整，视觉上轴就是"死的"。
    var xMax = Math.max(X_FLOOR, last ? last.sec : 0);
    var yMax = Math.max(Y_FLOOR, last ? last.rate : 0) * 1.04;   // 一点点余量，避免贴顶

    // 横轴跟随飞行时间连续增长：至少 10s（Y_FLOOR 同样的道理），
    // 已飞时间超过 10s 后按 0.5s 一格平滑推进，刻度标签也跟着走。
    var xStep = xMax <= 20 ? 2 : xMax <= 60 ? 5 : 10;

    var xFor = function (sec) { return padL + (sec / xMax) * gw; };
    var yFor = function (rate) { return padT + gh - ((rate - 1) / (yMax - 1)) * gh; };

    // 把绘图区几何暴露给火箭定位（app.js 用它把火箭放在曲线尖端）
    this.plot = { padL: padL, padR: padR, padT: padT, padB: padB, gw: gw, gh: gh, w: w, h: h, xFor: xFor, yFor: yFor };

    ctx.clearRect(0, 0, w, h);

    // ---------- 纵轴刻度 ----------
    // 标签数值也随 yMax 连续变化（原版 axisLabel 直接格式化实时 max，没有"取整档位"），
    // 所以飞行中你看到 2x→2.4x→3.1x 这样平滑走动，而不是固定 2x/3x/4x 三个死数。
    ctx.font = '600 12px ' + fam;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (i = 1; i <= 4; i++) {
      var v = 1 + (yMax - 1) * (i / 4);
      var yy = yFor(v);
      ctx.strokeStyle = GRID;
      ctx.globalAlpha = .55;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = AXIS;
      ctx.fillText(fmtNum(v) + 'x', padL - 6, yy);
    }

    // ---------- 横轴刻度（formatter '{value}s'，inside，不显示首尾）----------
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (i = 1; i * xStep < xMax; i++) {
      var xs = xFor(i * xStep);
      ctx.strokeStyle = AXIS;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xs, padT + gh); ctx.lineTo(xs, padT + gh + 4); ctx.stroke();
      ctx.fillStyle = AXIS;
      ctx.fillText(i * xStep + 's', xs, padT + gh + 6);
    }

    // ---------- 轴线 ----------
    ctx.strokeStyle = AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + gh); ctx.stroke();  // 竖轴
    ctx.beginPath(); ctx.moveTo(padL, padT + gh); ctx.lineTo(w - padR, padT + gh); ctx.stroke(); // 横轴
    // 1.00x 基线（yAxis min = 1）
    ctx.globalAlpha = .7;
    ctx.beginPath(); ctx.moveTo(padL, yFor(1)); ctx.lineTo(w - padR, yFor(1)); ctx.stroke();
    ctx.globalAlpha = 1;

    if (this.status === 'preview') {
      // ---------- 下注期：只画坐标轴，不放任何提示文字 ----------
      // 用户要求去掉图表中间的「下注中 / 起飞中 / 等待起飞」等字样。
      return;
    }

    if (!S.length) return;

    // ---------- 面积渐变（rgba(255,255,255,.3) → .05）----------
    ctx.save();
    var ag = ctx.createLinearGradient(0, padT, 0, padT + gh);
    ag.addColorStop(0, 'rgba(255,255,255,0.30)');
    ag.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.beginPath();
    ctx.moveTo(xFor(S[0].sec), yFor(1));
    for (i = 0; i < S.length; i++) ctx.lineTo(xFor(S[i].sec), yFor(S[i].rate));
    ctx.lineTo(xFor(S[S.length - 1].sec), yFor(1));
    ctx.closePath();
    ctx.fillStyle = ag;
    ctx.fill();
    ctx.restore();

    // ---------- 曲线本体（cornflowerblue）----------
    ctx.save();
    ctx.strokeStyle = this.status === 'over' ? '#ED4245' : LINE;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = this.status === 'over' ? 'rgba(237,66,69,.45)' : 'rgba(100,149,237,.4)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (i = 0; i < S.length; i++) {
      var px = xFor(S[i].sec), py = yFor(S[i].rate);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    // ---------- 爆点标记 ----------
    if (this.status === 'over' && last) {
      var bx = xFor(last.sec), by = yFor(last.rate);
      ctx.save();
      ctx.fillStyle = '#ED4245';
      ctx.shadowColor = 'rgba(237,66,69,.9)';
      ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  };

  function fmtNum(v) {
    if (v >= 100) return String(Math.round(v));
    if (v >= 10) return v.toFixed(0);
    return v.toFixed(1).replace(/\.0$/, '');
  }

  global.BoomChart = BoomChart;
})(window);
