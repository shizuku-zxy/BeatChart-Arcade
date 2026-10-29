// ============ 透视式渲染器（pjsk 高速公路感）：落点一条轴 + 远端消失点 ============
// 与下落式共用：判定引擎/HUD/判定线/中心标记/打击特效/误差条。
// 差异仅在几何：
//   - 消失点 VP 在屏幕外上方（W/2, -H*0.25），所有轨道向 VP 汇聚
//   - note 位置 = VP → 轨道落点的插值，插值系数 q = (K/(dt+K))^P（幂函数缓动：
//     近大远小但末端增长平缓，v1.5.2 修复"大的太快"）
//   - hold 为沿飞行路径的梯形条带（Graphics 每帧重绘）
//   - 触摸命中：按触点高度的透视几何吸附轨道列（v1.5.2 修复"反应区偏右"——
//     旧版用底部全宽几何，屏幕中上部点 note 视觉位置会判到右侧轨道）

import * as PIXI from 'pixi.js';
import '@pixi/unsafe-eval';
import { GameRenderer, lightenColor, NOTE_GRAY } from './Renderer.js';
import { perspQ, visibleLeadTime } from '../core/timeutil.js';

export class PerspectiveRenderer extends GameRenderer {

  _layout() {
    super._layout();
    // v1.6.1：消失点 -0.45H → -0.25H。旧值下 note 有 ~81% 可见时间压在屏幕下半段，
    // 顶部（手机短边侧）几乎无内容、视觉重心偏底，横屏方向不同偏侧不同。
    // 新值：dt=8K（渲染上限）时 y≈屏顶 3%，note 恰从屏幕顶出现；
    // 上下半屏停留时间 ≈54%/46%，内容铺满全屏。判定不受影响：
    // 判定基于时间窗口，触摸几何全部由 vpY 派生（所见即所判）。
    this.vpX = this.W * 0.5;
    this.vpY = -this.H * 0.25;
  }

  /** 轨道落点插值：q=0 在消失点，q=1 在判定线上的落点 */
  _lanePoint(lane, q) {
    const lx = this.fieldX + (lane + 0.5) * this.laneW;
    return {
      x: this.vpX + (lx - this.vpX) * q,
      y: this.vpY + (this.judgeY - this.vpY) * q,
    };
  }

  /** 触点高度 → 透视插值系数（与视觉几何一致：越靠上越向消失点收拢） */
  _sForY(y) {
    if (y >= this.judgeY) return 1;             // 判定线及以下：底部全宽
    if (y <= 0) return (0 - this.vpY) / (this.judgeY - this.vpY);  // 屏幕顶
    return (y - this.vpY) / (this.judgeY - this.vpY);
  }

  /**
   * 触摸命中检测（v1.5.2：按触点高度的透视几何吸附）。
   * 视觉上轨道在高度 y 处已向消失点收拢，命中判定必须用同一几何——
   * 否则点 note 的视觉位置会判到相邻（屏幕中心方向）的轨道。
   */
  hitTest(x, y) {
    if (y < 0 || y > this.H) return -1;
    const s = this._sForY(y);
    // 该高度处的轨道边界（透视插值后的边界）
    const edgeAt = (xBot) => this.vpX + (xBot - this.vpX) * s;
    const lo = edgeAt(this.fieldX) - this.laneW * s * 0.5;
    const hi = edgeAt(this.fieldX + this.fieldW) + this.laneW * s * 0.5;
    if (x < lo || x > hi) return -1;
    // 就近吸附：找该高度处最近的轨道中心
    let best = -1, bestD = Infinity;
    for (let l = 0; l < this.keyCount; l++) {
      const cx = edgeAt(this.fieldX + (l + 0.5) * this.laneW);
      const d = Math.abs(x - cx);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }

  /** 轨道底色：向消失点汇聚的梯形（屏幕顶窄、判定线处全宽，线下竖直延伸） */
  _drawLaneBg(hud) {
    const { fieldX, fieldW, laneW, judgeY, keyCount, H, vpX, vpY } = this;
    const xAtTop = (xLine) => vpX + (xLine - vpX) * ((0 - vpY) / (judgeY - vpY));
    for (let l = 0; l < keyCount; l++) {
      const xL = fieldX + l * laneW;
      const xR = xL + laneW;
      const bg = new PIXI.Graphics();
      bg.beginFill(0xffffff, l % 2 === 0 ? 0.03 : 0.06);
      bg.drawPolygon([
        xAtTop(xL), 0, xAtTop(xR), 0,
        xR, judgeY, xR, H, xL, H, xL, judgeY,
      ]);
      bg.endFill();
      hud.addChild(bg);
    }
    const border = new PIXI.Graphics();
    border.lineStyle(1, 0x6ec3ff, 0.4);
    border.moveTo(xAtTop(fieldX), 0); border.lineTo(fieldX, judgeY);
    border.moveTo(xAtTop(fieldX + fieldW), 0); border.lineTo(fieldX + fieldW, judgeY);
    for (let l = 1; l < keyCount; l++) {
      border.lineStyle(1, 0xffffff, 0.07);
      border.moveTo(xAtTop(fieldX + l * laneW), 0); border.lineTo(fieldX + l * laneW, judgeY);
    }
    hud.addChild(border);
  }

  /** hold 条带载体：Graphics（每帧重绘梯形） */
  _makeHoldBody() {
    return new PIXI.Graphics();
  }

  /**
   * 透视深度 → 屏幕插值系数（v1.8.1d：恢复 v1.8.0 基线，见 timeutil.perspQ）。
   * 幂函数 (K/(dt+K))^0.62 = 软化透视投影（pjsk“远慢近快”视觉的本体，
   * 用户认可的 1.8 手感）；v1.8.1f：渲染上限 8K → 12K（用户反馈“远处落得太快、
   * 屏幕上反应时间太少”，L10 下 1.6s → 2.4s；曲线/淡入带同步适配，
   * 近端冲刺速度由 approach 决定不变）。
   * 过线后（dt<0）q>1 继续外推放大（pjsk“从身边飞过”），上限 1.6 防发散。
   */
  _qFor(dt) {
    return perspQ(dt, this.approach);
  }

  /** 可见窗口（秒）：note 从出现到判定线的总时长（v1.8.1g = 8K 基线，带绝对下限；淡入缓冲带保留） */
  get leadTime() {
    return visibleLeadTime(this.approach, 1.6);
  }

  _updateNoteSprite(sp, time) {
    const n = sp.note;
    const state = n.state || 'pending';
    const K = this.approach;
    const head = sp.head;
    const dt = n.t - time;
    const q = this._qFor(dt);
    // v1.8.1f：淡入从 q=0.18 起步（越过屏顶 q≈0.256 延伸到屏外上方缓冲带），
    // 范围 0.18→0.34（宽 0.16，基线的 2 倍）——note 先在屏外上方渐显、再入屏，
    // 远端“突然出现后疾速进屏”的观感消除；总体窗口 8K 基线不变。
    const fadeIn = Math.min(1, Math.max(0, (q - 0.18) / 0.16));
    const laneCenter = this.fieldX + (n.lane + 0.5) * this.laneW;

    if (n.type !== 'hold') {
      // ---- tap：判定/漏掉即消失；超出可见窗口（v1.8.1f = leadTime）不渲染 ----
      if (state !== 'pending' || dt > this.leadTime || dt < -0.16) { head.visible = false; return; }
      const p = this._lanePoint(n.lane, q);
      head.x = p.x; head.y = p.y;
      head.scale.set(Math.max(0.18, q));
      head.alpha = fadeIn;
      head.visible = true;
      return;
    }

    // ---- hold ----
    const tailDt = (n.t + n.d) - time;
    const qTail = this._qFor(Math.max(0, tailDt));
    if (state === 'holding') {
      // 按住中：头钉判定线（白），尾 note 与条带顶端跟随尾部位置
      head.texture = this.tapTexWhite;
      head.x = laneCenter; head.y = this.judgeY;
      head.scale.set(1); head.alpha = 1; head.visible = true;
      const tp = this._lanePoint(n.lane, qTail);
      if (sp.tail) {
        sp.tail.texture = this.tapTexWhite;
        sp.tail.x = tp.x; sp.tail.y = tp.y;
        sp.tail.scale.set(Math.max(0.18, qTail));
        sp.tail.alpha = 0.95;
        sp.tail.visible = tailDt > 0.02;
      }
      if (sp.body) this._drawHoldBody(sp.body, laneCenter, this.judgeY, tp.x, tp.y, 1, qTail);
    } else if (state === 'pending') {
      if (dt > this.leadTime) { head.visible = false; if (sp.tail) sp.tail.visible = false; if (sp.body) sp.body.visible = false; return; }
      const hp = this._lanePoint(n.lane, q);
      const tp = this._lanePoint(n.lane, qTail);
      head.texture = sp.gray ? this.tapTexGray : this.tapTex;
      head.x = hp.x; head.y = hp.y;
      head.scale.set(Math.max(0.18, q));
      head.alpha = fadeIn;
      head.visible = true;
      if (sp.tail) {
        sp.tail.x = tp.x; sp.tail.y = tp.y;
        sp.tail.texture = sp.gray ? this.tapTexGray : this.tapTex;
        sp.tail.scale.set(Math.max(0.18, qTail));
        sp.tail.alpha = fadeIn;
        sp.tail.visible = true;
      }
      if (sp.body) this._drawHoldBody(sp.body, hp.x, hp.y, tp.x, tp.y, q, qTail, sp.gray);
    } else {
      // judged / done / broken：整条消失
      head.visible = false;
      if (sp.tail) sp.tail.visible = false;
      if (sp.body) sp.body.visible = false;
    }
  }

  /**
   * hold 透视梯形体（v1.5.3：头端宽度按深度缩放；v1.6.1：宽度上限 1 → 1.6）。
   * 未投影模型下，深度 q 截面 = 判定线截面以消失点为中心的位似变换（比例 q），
   * 因此锚定在轨道上的几何必须整体乘 q：位置（_lanePoint 已乘）与宽度都要乘。
   * 修复史：
   *   v1.5.3 前 wHead 写死满宽 → 出现时比轨道宽 ~1.8 倍、不平行（已修）；
   *   v1.6.1 前 qc 上限 min(1,·) → 过线后位置按 q>1 外推而宽度停在满宽，
   *   位似破坏：头贴图继续变大、身体相对变窄且边缘离开轨道射线（"过线形变
   *   变窄"）。现在宽度与位置同按 q 外推（上限 1.6 与 _qFor 一致），身体恒为
   *   轨道 62%、严格沿射线、与头贴图比例全程恒定。
   */
  _drawHoldBody(g, hx, hy, tx, ty, qHead, qTail, gray) {
    const qc = (v) => Math.min(1.6, Math.max(0.22, v));
    const wHead = this.laneW * 0.62 * qc(qHead);
    const wTail = this.laneW * 0.62 * qc(qTail);
    // 冒烟断言用（头尾左缘与 vp 的位似系数应严格相等 → 与轨道共消失点平行）
    this._dbg = { hx, tx, wHead, wTail, qHead: qc(qHead), qTail: qc(qTail) };
    const col = gray ? NOTE_GRAY : this.diffColor;
    g.clear();
    // 实心底（沿飞行路径的梯形）
    g.beginFill(col, 0.9);
    g.drawPolygon([hx - wHead / 2, hy, tx - wTail / 2, ty, tx + wTail / 2, ty, hx + wHead / 2, hy]);
    g.endFill();
    // 两侧亮导轨（沿透视边）
    g.lineStyle(2.5, lightenColor(col, 0.5), 1);
    g.moveTo(hx - wHead / 2, hy); g.lineTo(tx - wTail / 2, ty);
    g.moveTo(hx + wHead / 2, hy); g.lineTo(tx + wTail / 2, ty);
    // 中心能量线
    g.lineStyle(2, 0xffffff, 0.8);
    g.moveTo(hx, hy); g.lineTo(tx, ty);
    g.visible = true;
  }
}
