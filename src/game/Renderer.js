// ============ PixiJS 游戏渲染器：多轨下落 + 判定反馈 ============
// 结构：stage 固定三层（自底向上）→ note 层 / HUD 层 / 特效层，
//       尺寸变化时仅重建各层内容，层容器与顺序恒定。

import * as PIXI from 'pixi.js';
// CSP 禁用 unsafe-eval 的环境下（Electron 打包 + 严格 CSP），
// PixiJS 动态生成的 uniform 同步函数不可用会抛错；此包导入即自动打补丁（7.1+ 自安装）
import '@pixi/unsafe-eval';

const JUDGE_STYLE = {
  perfect: { text: 'PERFECT', color: 0x6ef7d8 },
  great: { text: 'GREAT', color: 0x6ec3ff },
  good: { text: 'GOOD', color: 0xffd76e },
  miss: { text: 'MISS', color: 0xff6e7a },
};

function clearLayer(layer) {
  layer.removeChildren().forEach((c) => c.destroy());
}

/** 颜色向白色提亮（长键导轨等用） */
export function lightenColor(c, f) {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const nr = Math.round(r + (255 - r) * f);
  const ng = Math.round(g + (255 - g) * f);
  const nb = Math.round(b + (255 - b) * f);
  return (nr << 16) | (ng << 8) | nb;
}

/** 手录谱“回退段”灰音符颜色（v1.7.0：保留待重录的音符，照常下落但呈灰色） */
export const NOTE_GRAY = 0x5a6a80;

export class GameRenderer {
  /**
   * @param {HTMLElement} container
   * @param {object} opts { keyCount, approach, diffColor, keyLabels }
   */
  constructor(container, opts) {
    this.container = container;
    this.keyCount = opts.keyCount || 4;
    this.approach = opts.approach || 0.7;
    this.diffColor = opts.diffColor != null ? opts.diffColor : 0x6ec3ff;
    this.keyLabels = opts.keyLabels || [];
    this.flashes = [];
    this.bursts = [];     // v1.5.0：打击特效（扩散环/粒子）
    this.offsets = [];    // v1.5.0：最近判定偏移记录（秒，正=晚）
    this.sprites = [];
    this.duration = 0;
    this._notes = [];

    this.app = new PIXI.Application({
      width: container.clientWidth || 1280,
      height: container.clientHeight || 720,
      backgroundColor: 0x0a0e18,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    container.appendChild(this.app.view);

    // 固定三层：note（底）→ HUD（中）→ 特效（顶）
    this.noteLayer = new PIXI.Container();
    this.hudLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();
    this.app.stage.addChild(this.noteLayer, this.hudLayer, this.fxLayer);

    this._layout();
    this._rebuildHud();

    this.app.ticker.add(() => this._tick());
    this._resizeHandler = () => {
      this.app.renderer.resize(container.clientWidth, container.clientHeight);
      this._layout();
      this._rebuildHud();
      this._buildNotes(this._notes);
    };
    window.addEventListener('resize', this._resizeHandler);
  }

  // ---------- 布局 ----------
  _layout() {
    const res = this.app.renderer.resolution;
    this.W = this.app.renderer.width / res;
    this.H = this.app.renderer.height / res;
    this.laneW = Math.min(130, Math.max(70, this.W / (this.keyCount + 2.2)));
    this.fieldW = this.laneW * this.keyCount;
    this.fieldX = (this.W - this.fieldW) / 2;
    this.judgeY = this.H * 0.84;
    this.pixelsPerSec = this.judgeY / this.approach;
  }

  // ---------- HUD 层 ----------
  _rebuildHud() {
    clearLayer(this.hudLayer);
    const { fieldX, fieldW, laneW, judgeY, W, H, keyCount } = this;
    const hud = this.hudLayer;

    this._drawLaneBg(hud);
    // 判定线光晕 + 判定线（v1.5.0 加亮加长）
    const glow = new PIXI.Graphics();
    glow.beginFill(0x6ec3ff, 0.18);
    glow.drawRect(fieldX - 8, judgeY - 14, fieldW + 16, 14);
    glow.endFill();
    hud.addChild(glow);
    const line = new PIXI.Graphics();
    line.lineStyle(3.5, 0xffffff, 0.95);
    line.moveTo(fieldX - 12, judgeY); line.lineTo(fieldX + fieldW + 12, judgeY);
    hud.addChild(line);
    // v1.5.0：每轨正中心 = 精确判定位置（菱形标记嵌在判定线上）
    for (let l = 0; l < keyCount; l++) {
      const cx = fieldX + (l + 0.5) * laneW;
      const m = new PIXI.Graphics();
      m.beginFill(0xffffff, 0.95);
      m.drawPolygon([cx, judgeY - 8, cx + 6, judgeY, cx, judgeY + 8, cx - 6, judgeY]);
      m.endFill();
      hud.addChild(m);
    }

    // 键位标签 + 按下发光
    this.laneGlows = [];
    for (let l = 0; l < keyCount; l++) {
      const t = new PIXI.Text(this.keyLabels[l] || '', {
        fontFamily: 'Consolas, monospace', fontSize: 20, fill: 0x8fb8dd, fontWeight: '700',
      });
      t.anchor.set(0.5);
      t.x = fieldX + (l + 0.5) * laneW;
      t.y = judgeY + 26;
      hud.addChild(t);
      const g = new PIXI.Graphics();
      g.beginFill(0x6ec3ff, 1);
      g.drawRect(fieldX + l * laneW + 3, judgeY - 6, laneW - 6, 6);
      g.endFill();
      g.alpha = 0;
      hud.addChild(g);
      this.laneGlows.push(g);
    }

    // HUD 文本（v1.5.3：得分块左移至 W-96，给右上角暂停键让位）
    this.scoreText = new PIXI.Text('0', { fontFamily: 'Consolas, monospace', fontSize: 30, fill: 0xffffff, fontWeight: '800' });
    this.scoreText.anchor.set(1, 0);
    this.scoreText.x = W - 96; this.scoreText.y = 18;
    hud.addChild(this.scoreText);

    this.accText = new PIXI.Text('100.00%', { fontFamily: 'Consolas, monospace', fontSize: 18, fill: 0x8fb8dd });
    this.accText.anchor.set(1, 0);
    this.accText.x = W - 96; this.accText.y = 56;
    hud.addChild(this.accText);

    // v1.5.3：歌名限定区域（右侧让位给中间提示文字）；过长时跑马灯往返滚动
    this.titleText = new PIXI.Text(this._title || '', { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 15, fill: 0x5f7f9f });
    this.titleText.x = 24; this.titleText.y = 18;
    hud.addChild(this.titleText);
    this.titleRegionW = Math.max(140, W / 2 - 170 - 24);
    const titleMask = new PIXI.Graphics();
    titleMask.beginFill(0xffffff, 1);
    titleMask.drawRect(24, 10, this.titleRegionW, 32);
    titleMask.endFill();
    hud.addChild(titleMask);
    this.titleText.mask = titleMask;

    this.comboText = new PIXI.Text('', { fontFamily: 'Consolas, monospace', fontSize: 54, fill: 0xffffff, fontWeight: '800' });
    this.comboText.anchor.set(0.5);
    this.comboText.x = W / 2; this.comboText.y = H * 0.3;
    hud.addChild(this.comboText);

    this.comboLabel = new PIXI.Text('', { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 16, fill: 0x8fb8dd });
    this.comboLabel.anchor.set(0.5);
    this.comboLabel.x = W / 2; this.comboLabel.y = H * 0.3 + 42;
    hud.addChild(this.comboLabel);

    this.progBar = new PIXI.Graphics();
    hud.addChild(this.progBar);

    this.countdownText = new PIXI.Text('', { fontFamily: 'Consolas, monospace', fontSize: 110, fill: 0xffffff, fontWeight: '800' });
    this.countdownText.anchor.set(0.5);
    this.countdownText.x = W / 2; this.countdownText.y = H * 0.42;
    hud.addChild(this.countdownText);

    // v1.5.0：顶部误差条（最近判定的早晚偏移，早←0→晚）
    this.offsetBar = new PIXI.Graphics();
    hud.addChild(this.offsetBar);
  }

  /** 轨道底色 + 边框（下落式：竖直条纹；透视式子类覆写为汇聚梯形） */
  _drawLaneBg(hud) {
    const { fieldX, fieldW, laneW, judgeY, keyCount } = this;
    for (let l = 0; l < keyCount; l++) {
      const bg = new PIXI.Graphics();
      bg.beginFill(0xffffff, l % 2 === 0 ? 0.028 : 0.055);
      bg.drawRect(fieldX + l * laneW, 0, laneW, judgeY);
      bg.endFill();
      hud.addChild(bg);
    }
    const border = new PIXI.Graphics();
    border.lineStyle(1, 0x6ec3ff, 0.35);
    border.moveTo(fieldX, 0); border.lineTo(fieldX, judgeY);
    border.moveTo(fieldX + fieldW, 0); border.lineTo(fieldX + fieldW, judgeY);
    for (let l = 1; l < keyCount; l++) {
      border.lineStyle(1, 0xffffff, 0.05);
      border.moveTo(fieldX + l * laneW, 0); border.lineTo(fieldX + l * laneW, judgeY);
    }
    hud.addChild(border);
  }

  /** hold 身体载体（v1.5.1：实心胶囊体，Graphics 每帧重绘；透视式子类覆写为梯形） */
  _makeHoldBody() {
    return new PIXI.Graphics();
  }

  // ---------- note 层 ----------
  setInfo(title, duration) {
    this._title = title || '';
    this.titleText.text = this._title;
    this.duration = duration || 0;
    this._titleT = 0; // 跑马灯相位重置
  }

  loadNotes(notes) {
    this._notes = notes || [];
    this._buildNotes(this._notes);
  }

  _makeTapTexture(color) {
    const g = new PIXI.Graphics();
    const w = this.laneW * 0.86, h = 24;
    g.beginFill(color);
    g.drawRoundedRect(-w / 2, -h / 2, w, h, 8);
    g.endFill();
    g.beginFill(0xffffff, 0.35);
    g.drawRoundedRect(-w / 2 + 2, -h / 2 + 2, w - 4, 7, 4);
    g.endFill();
    return this.app.renderer.generateTexture(g);
  }
  _buildNotes(notes) {
    clearLayer(this.noteLayer);
    this.tapTex = this._makeTapTexture(this.diffColor);
    this.tapTexWhite = this._makeTapTexture(0xffffff);
    this.tapTexGray = this._makeTapTexture(NOTE_GRAY);
    this.sprites = [];
    for (const n of notes) {
      if (n.type === 'hold') {
        const body = this._makeHoldBody();
        const head = new PIXI.Sprite(this.tapTex);
        head.anchor.set(0.5, 0.5);
        // v1.5.1：尾部为小号收口块（0.72 缩放，宽度恰等于身体宽），整体读作一个设计元素
        const tail = new PIXI.Sprite(this.tapTex);
        tail.anchor.set(0.5, 0.5);
        tail.scale.set(0.72);
        this.noteLayer.addChild(body, head, tail);
        this.sprites.push({ note: n, head, body, tail, gray: !!n.gray });
      } else {
        const s = new PIXI.Sprite(this.tapTex);
        s.anchor.set(0.5, 0.5);
        this.noteLayer.addChild(s);
        this.sprites.push({ note: n, head: s, gray: !!n.gray });
      }
    }
  }

  // ---------- 交互反馈 ----------
  laneHit(lane) {
    const g = this.laneGlows && this.laneGlows[lane];
    if (g) g.alpha = 1;
  }

  /** 触摸命中检测（v1.4.0：手机端竖直下落，点轨道列判定；全列可点、x 就近吸附） */
  hitTest(x, y) {
    if (y < 0 || y > this.H) return -1;
    const lo = this.fieldX - this.laneW * 0.5;
    const hi = this.fieldX + this.fieldW + this.laneW * 0.5;
    if (x < lo || x > hi) return -1;
    const l = Math.floor((x - this.fieldX + this.laneW * 0.5) / this.laneW);
    return Math.max(0, Math.min(this.keyCount - 1, l));
  }

  /** 判定反馈（v1.5.0：画在被击打轨道上方 + 早/晚偏移 + 打击特效；v1.5.3：高度随屏高缩放，手机上更贴近判定线） */
  showJudge(judge, lane, offsetMs, isTail) {
    const st = JUDGE_STYLE[judge];
    if (!st) return;
    const lx = (lane == null || lane < 0)
      ? this.W / 2
      : this.fieldX + (lane + 0.5) * this.laneW;
    const lift = Math.min(74, this.H * 0.14);
    const t = new PIXI.Text(st.text + (isTail ? '·尾' : ''), {
      fontFamily: 'Consolas, monospace', fontSize: 21, fill: st.color, fontWeight: '800',
    });
    t.anchor.set(0.5);
    t.x = lx;
    t.y = this.judgeY - lift;
    this.fxLayer.addChild(t);
    this.flashes.push({ text: t, life: 0.5, max: 0.5 });
    // 早/晚偏移指示（miss 不显示；perfect 且偏差 <15ms 也不显示）
    if (offsetMs != null && Number.isFinite(offsetMs) && judge !== 'miss'
      && (judge !== 'perfect' || Math.abs(offsetMs) > 15)) {
      const early = offsetMs < 0;
      const sub = new PIXI.Text(
        (early ? '早 ' : '晚 ') + Math.abs(Math.round(offsetMs)) + 'ms',
        { fontFamily: 'Consolas, monospace', fontSize: 13, fill: early ? 0x9fd7ff : 0xffb39e }
      );
      sub.anchor.set(0.5);
      sub.x = lx;
      sub.y = this.judgeY - lift + 22;
      this.fxLayer.addChild(sub);
      this.flashes.push({ text: sub, life: 0.5, max: 0.5 });
    }
    // 误差条记录
    if (offsetMs != null && Number.isFinite(offsetMs)) {
      this.offsets.push(offsetMs / 1000);
      if (this.offsets.length > 32) this.offsets.shift();
    }
    // 打击特效（非 miss）
    if (judge !== 'miss' && lane != null && lane >= 0) this.hitBurst(lx, this.judgeY, judge);
  }

  /** 打击特效：扩散环 + 粒子飞溅（perfect 更强） */
  hitBurst(x, y, judge) {
    const strong = judge === 'perfect';
    const color = JUDGE_STYLE[judge].color;
    const ring = new PIXI.Graphics();
    ring.lineStyle(3, color, 0.9);
    ring.drawCircle(0, 0, 12);
    ring.x = x; ring.y = y;
    this.fxLayer.addChild(ring);
    this.bursts.push({ g: ring, life: 0.3, max: 0.3, r0: 10, r1: strong ? this.laneW * 0.85 : this.laneW * 0.55 });
    const n = strong ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const p = new PIXI.Graphics();
      const s = strong ? 5 : 4;
      p.beginFill(color, 0.95);
      p.drawRect(-s / 2, -s / 2, s, s);
      p.endFill();
      p.x = x; p.y = y;
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const spd = (strong ? 250 : 160) * (0.7 + Math.random() * 0.6);
      this.fxLayer.addChild(p);
      this.bursts.push({ g: p, life: 0.45, max: 0.45, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, grav: 900, rot: (Math.random() - 0.5) * 12 });
    }
  }

  // ---------- 每帧由外部驱动（音频时钟） ----------
  render(time, hud) {
    const { W, H } = this;
    for (const sp of this.sprites) this._updateNoteSprite(sp, time);

    // ---- HUD ----
    if (!hud) return;
    this.scoreText.text = String(hud.score).padStart(7, '0');
    this.accText.text = hud.accuracy.toFixed(2) + '%';
    if (hud.combo >= 3) {
      this.comboText.visible = this.comboLabel.visible = true;
      this.comboText.text = String(hud.combo);
      this.comboLabel.text = 'COMBO';
      this.comboText.scale.set(hud.combo % 50 === 0 ? 1.18 : 1);
    } else {
      this.comboText.visible = this.comboLabel.visible = false;
    }
    if (this.duration > 0) {
      const p = Math.max(0, Math.min(1, time / this.duration));
      this.progBar.clear();
      this.progBar.beginFill(0x6ec3ff, 0.15);
      this.progBar.drawRect(24, H - 12, W - 48, 4);
      this.progBar.endFill();
      this.progBar.beginFill(0x6ec3ff, 0.9);
      this.progBar.drawRect(24, H - 12, (W - 48) * p, 4);
      this.progBar.endFill();
    }
    // v1.5.0：顶部误差条（最近判定偏移；早←0→晚，±200ms 满量程）
    if (this.offsetBar) {
      this.offsetBar.clear();
      const bx = W / 2, by = 88, bw = 180;
      this.offsetBar.beginFill(0xffffff, 0.08);
      this.offsetBar.drawRect(bx - bw / 2, by, bw, 5);
      this.offsetBar.endFill();
      this.offsetBar.beginFill(0xffffff, 0.55);
      this.offsetBar.drawRect(bx - 0.75, by - 4, 1.5, 13);
      this.offsetBar.endFill();
      const offs = this.offsets.slice(-14);
      for (let i = 0; i < offs.length; i++) {
        const ms = Math.max(-200, Math.min(200, offs[i] * 1000));
        const x = bx + (ms / 200) * (bw / 2 - 4);
        const age = offs.length - 1 - i;
        this.offsetBar.beginFill(0x6ec3ff, Math.max(0.18, 0.95 - age * 0.06));
        this.offsetBar.drawRect(x - 1, by - 3, 2, 11);
        this.offsetBar.endFill();
      }
    }
    // 倒计时 / GO
    if (time < -0.05) {
      const n = Math.ceil(-time);
      this.countdownText.visible = true;
      this.countdownText.text = n > 3 ? '准备' : String(n);
      this.countdownText.alpha = 0.5 + 0.5 * (1 - ((-time) % 1));
    } else if (time < 0.6) {
      this.countdownText.visible = true;
      this.countdownText.text = 'GO';
      this.countdownText.alpha = Math.max(0, 1 - time / 0.6);
    } else this.countdownText.visible = false;
  }

  /** 单个 note 的视觉更新（下落式：竖直匀速下落；透视式子类覆写为深度投影） */
  _updateNoteSprite(sp, time) {
    const { judgeY, pixelsPerSec, fieldX, laneW, approach } = this;
    const n = sp.note;
    const state = n.state || 'pending';
    const dt = n.t - time;                       // note 头距判定线的时间
    const head = sp.head;
    if (dt > approach + 0.5) { head.visible = false; if (sp.body) sp.body.visible = false; if (sp.tail) sp.tail.visible = false; return; }

    if (n.type !== 'hold') {
      // ---- tap：判定/漏掉即消失（v1.5.0 打击感） ----
      if (state !== 'pending') { head.visible = false; return; }
      const y = judgeY - dt * pixelsPerSec;
      head.x = fieldX + (n.lane + 0.5) * laneW;
      head.y = y;
      head.visible = y > -40 && dt > -0.16;
      return;
    }

    // ---- hold：实心胶囊体（v1.5.1 单独设计，整体一个元素） ----
    const tailDt = (n.t + n.d) - time;           // note 尾距判定线的时间
    const laneX = fieldX + (n.lane + 0.5) * laneW;
    if (state === 'holding') {
      // 按住中：头钉判定线（白），身体顶端跟随尾部位置
      head.texture = this.tapTexWhite;
      head.x = laneX; head.y = judgeY; head.alpha = 1; head.visible = true;
      head.scale.set(1);
      const tailY = judgeY - Math.max(0, tailDt) * pixelsPerSec;
      if (sp.tail) {
        sp.tail.x = laneX;
        sp.tail.y = tailY;
        sp.tail.texture = this.tapTexWhite;
        sp.tail.scale.set(0.72);
        sp.tail.alpha = 0.95;
        sp.tail.visible = tailDt > 0.02 && tailY > -40;
      }
      if (sp.body) this._drawHoldBody(sp.body, laneX, judgeY, tailY, true, time);
    } else if (state === 'pending') {
      const headY = judgeY - dt * pixelsPerSec;
      const tailY = judgeY - tailDt * pixelsPerSec;
      head.texture = sp.gray ? this.tapTexGray : this.tapTex;
      head.x = laneX; head.y = headY;
      head.alpha = 1;
      head.scale.set(1);
      head.visible = headY > -40;
      if (sp.tail) {
        sp.tail.x = laneX;
        sp.tail.y = tailY;
        sp.tail.texture = sp.gray ? this.tapTexGray : this.tapTex;
        sp.tail.scale.set(0.72);
        sp.tail.alpha = 0.95;
        sp.tail.visible = tailY > -20;
      }
      if (sp.body) this._drawHoldBody(sp.body, laneX, headY, tailY, false, time, sp.gray);
    } else {
      // judged / done / broken：整条消失
      head.visible = false;
      if (sp.body) sp.body.visible = false;
      if (sp.tail) sp.tail.visible = false;
    }
  }

  /**
   * hold 实心胶囊体绘制（v1.5.1 单独设计）：
   * 实心底色 + 内嵌深芯 + 两侧亮导轨 + 中心能量线 + 节拍刻度 + 尾端圆角；
   * 头/尾由 tap note 收口——整条读作一个完整设计元素，不再是半透明拼接条带。
   * @param {number} headY 头端 Y（下端，屏幕坐标大）
   * @param {number} tailY 尾端 Y（上端）
   */
  _drawHoldBody(g, laneX, headY, tailY, active, time, gray) {
    const w = this.laneW * 0.62;
    const top = Math.min(headY, tailY);
    const bot = Math.max(headY, tailY);
    const h = bot - top;
    const col = gray ? NOTE_GRAY : this.diffColor;
    g.clear();
    if (h < 5) { g.visible = false; return; }
    g.visible = true;
    const railC = lightenColor(col, 0.5);
    // 实心底（尾端圆角收口；头端被 tap note 覆盖）
    g.beginFill(col, active ? 0.96 : 0.9);
    g.drawRoundedRect(laneX - w / 2, top, w, h, 7);
    g.endFill();
    // 内嵌深芯（结构感）
    g.beginFill(0x000810, active ? 0.20 : 0.30);
    g.drawRoundedRect(laneX - w / 2 + 3.5, top + 3, w - 7, Math.max(0, h - 5), 5);
    g.endFill();
    // 两侧亮导轨
    g.beginFill(railC, 1);
    g.drawRect(laneX - w / 2, top, 3, h);
    g.drawRect(laneX + w / 2 - 3, top, 3, h);
    g.endFill();
    // 中心能量线
    g.beginFill(0xffffff, active ? 0.95 : 0.72);
    g.drawRect(laneX - 1, top, 2, h);
    g.endFill();
    // 节拍刻度（每拍一道，随音乐下落；未知 BPM 时跳过）
    if (this.beatSec > 0 && this.beat0 != null) {
      const tLo = time + (this.judgeY - bot) / this.pixelsPerSec;
      const tHi = time + (this.judgeY - top) / this.pixelsPerSec;
      const k0 = Math.ceil((tLo - this.beat0) / this.beatSec);
      const k1 = Math.floor((tHi - this.beat0) / this.beatSec);
      g.beginFill(0xffffff, 0.42);
      for (let k = k0; k <= k1 && k - k0 < 64; k++) {
        const tb = this.beat0 + k * this.beatSec;
        const y = this.judgeY - (tb - time) * this.pixelsPerSec;
        if (y > top + 6 && y < bot - 6) g.drawRect(laneX - w / 2 + 3, y - 1.5, w - 6, 3);
      }
      g.endFill();
    }
  }

  /** 节拍网格（供长键节拍刻度用；GameScreen 创建渲染器后调用） */
  setRhythm(bpm, beat0) {
    this.beatSec = bpm > 0 ? 60 / bpm : null;
    this.beat0 = Number.isFinite(beat0) ? beat0 : 0;
  }

  // 视觉动画（判定文字/特效衰减），独立于音频时钟
  _tick() {
    const dtSec = this.app.ticker.deltaMS / 1000;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dtSec;
      if (f.life <= 0) { f.text.destroy(); this.flashes.splice(i, 1); continue; }
      const p = f.life / f.max;
      f.text.alpha = p;
      f.text.y -= 34 * dtSec;
    }
    // 打击特效（扩散环 / 粒子）
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dtSec;
      if (b.life <= 0) { b.g.destroy(); this.bursts.splice(i, 1); continue; }
      const p = b.life / b.max;
      if (b.r1 != null) {
        const r = b.r0 + (b.r1 - b.r0) * (1 - p);
        b.g.scale.set(r / 12);
      } else {
        b.vy += (b.grav || 0) * dtSec;
        b.g.x += b.vx * dtSec;
        b.g.y += b.vy * dtSec;
        b.g.rotation += (b.rot || 0) * dtSec;
      }
      b.g.alpha = p;
    }
    if (this.laneGlows) for (const g of this.laneGlows) if (g.alpha > 0) g.alpha = Math.max(0, g.alpha - 3.2 * dtSec);
    // v1.5.3：歌名跑马灯（超出限定区域时往返滚动，34px/s）
    if (this.titleText && this.titleRegionW) {
      const over = this.titleText.width - this.titleRegionW;
      if (over > 8) {
        this._titleT = (this._titleT || 0) + dtSec;
        const span = over + 48;
        const cyc = (this._titleT * 34) % (span * 2);
        const off = cyc < span ? cyc : span * 2 - cyc;
        this.titleText.x = 24 - off;
      } else {
        this.titleText.x = 24;
      }
    }
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
    this.app.destroy(true, { children: true });
  }
}
