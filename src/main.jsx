import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { GameRenderer } from './game/Renderer.js';
import { PerspectiveRenderer } from './game/PerspectiveRenderer.js';

const SMOKE_NOTES = [
  { t: 1.0, lane: 0, type: 'tap' },
  { t: 1.2, lane: 2, type: 'tap' },
  { t: 0.9, lane: 1, type: 'hold', d: 0.5 },
];

// 冒烟测试钩子：无头构造两种渲染器（下落式 + 透视式）各渲染一帧，
// 覆盖 PixiJS 初始化类错误（CSP unsafe-eval / WebGL / 布局计算 / 透视投影），
// 防止游戏页启动失败回归。
if (typeof window !== 'undefined') {
  window.__BCPokeRenderer = function () {
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:640px;';
    document.body.appendChild(div);
    try {
      // ---- 下落式 ----
      const r = new GameRenderer(div, { keyCount: 4, approach: 0.7, diffColor: 0x6ec3ff, keyLabels: ['D', 'F', 'J', 'K'] });
      r.setInfo('smoke', 10);
      r.loadNotes(SMOKE_NOTES);
      r.render(0.5, { score: 0, accuracy: 100, combo: 0 });
      const lane0X = r.fieldX + r.laneW * 0.5;
      const fallCenter = r.hitTest(lane0X, r.judgeY);
      const fallFar = r.hitTest(r.W - 4, 4);
      const fallLane3 = r.hitTest(r.fieldX + r.laneW * 3.5, r.judgeY);
      const holdSprites = r.sprites.filter((sp) => sp.note.type === 'hold');
      const holdTailOK = holdSprites.length > 0 && holdSprites.every((sp) => sp.tail && sp.tail.texture);
      // v1.5.1：实心胶囊体（Graphics）在窗口内被绘制
      const holdBody = holdSprites[0] && holdSprites[0].body;
      const holdBodyOK = holdBody && typeof holdBody.clear === 'function' && holdBody.visible === true;
      r.destroy();

      // ---- 透视式 ----
      const r2 = new PerspectiveRenderer(div, { keyCount: 4, approach: 0.7, diffColor: 0xff7a9e, keyLabels: ['D', 'F', 'J', 'K'] });
      r2.setInfo('smoke', 10);
      r2.loadNotes(SMOKE_NOTES);
      r2.render(0.5, { score: 0, accuracy: 100, combo: 0 });
      const perspLane0 = r2.hitTest(r2.fieldX + r2.laneW * 0.5, r2.judgeY);
      const perspFar = r2.hitTest(r2.W - 4, 4);
      // v1.5.2 透视命中按高度几何：屏幕中上部点"轨道视觉中心"必须命中本轨道
      // （旧版用底部全宽几何，左侧轨道会判到右侧——即"反应区偏右"bug）
      const midY = r2.judgeY * 0.5;
      const sMid = r2._sForY(midY);
      const perspMidLane0 = r2.hitTest(r2.vpX + (r2.fieldX + r2.laneW * 0.5 - r2.vpX) * sMid, midY);
      const perspMidLane3 = r2.hitTest(r2.vpX + (r2.fieldX + r2.laneW * 3.5 - r2.vpX) * sMid, midY);
      // 缩放缓动（v1.5.2 幂函数；v1.8.1d 恢复 0.62 基线）：dt=K 处 q=0.5^0.62≈0.651
      const qEaseOK = Math.abs(r2._qFor(0.7) - Math.pow(0.5, 0.62)) < 0.02;
      // 投影几何：第一个 tap（t=1.0，dt=0.5）q=(0.7/1.2)^0.62
      const first = r2.sprites[0];
      const qExp = Math.pow(0.7 / 1.2, 0.62);
      const scaleOK = first && Math.abs(first.head.scale.x - Math.max(0.18, qExp)) < 0.02;
      // 位置应在落点与消失点之间（向中心收敛）
      const lane0Cx = r2.fieldX + r2.laneW * 0.5;
      const midOK = first && first.head.x > lane0Cx && first.head.x < r2.vpX
        && first.head.y > 0 && first.head.y < r2.judgeY;
      const perspHold = r2.sprites.filter((sp) => sp.note.type === 'hold')[0];
      const perspHoldOK = perspHold && perspHold.body;
      // v1.5.3：长键身体与轨道严格平行 + 头端宽度随深度缩放（位似不变）
      // 平行判定：头/尾左缘相对消失点的位似系数应相等（三点共线于过 vp 的射线）
      const dbg = r2._dbg;
      const cH = dbg ? (dbg.hx - dbg.wHead / 2 - r2.vpX) / dbg.qHead : NaN;
      const cT = dbg ? (dbg.tx - dbg.wTail / 2 - r2.vpX) / dbg.qTail : NaN;
      const holdParallelOK = dbg && Number.isFinite(cH) && Number.isFinite(cT) && Math.abs(cH - cT) < 1.5;
      const holdWidthOK = dbg && Math.abs(dbg.wHead / (r2.laneW * dbg.qHead) - 0.62) < 0.02;
      r2.destroy();
      div.remove();

      if (fallCenter !== 0) return 'fall_hitTest_lane0_miss:' + fallCenter;
      if (fallFar >= 0) return 'fall_hitTest_false_positive';
      if (fallLane3 !== 3) return 'fall_hitTest_lane3_miss:' + fallLane3;
      if (!holdTailOK) return 'hold_tail_missing';
      if (!holdBodyOK) return 'hold_body_not_drawn';
      if (perspLane0 !== 0) return 'persp_hitTest_lane0_miss:' + perspLane0;
      if (perspFar >= 0) return 'persp_hitTest_false_positive';
      if (perspMidLane0 !== 0) return 'persp_midY_lane0_miss:' + perspMidLane0;
      if (perspMidLane3 !== 3) return 'persp_midY_lane3_miss:' + perspMidLane3;
      if (!qEaseOK) return 'persp_q_easing_off';
      if (!scaleOK) return 'persp_projection_scale_off';
      if (!midOK) return 'persp_projection_position_off';
      if (!perspHoldOK) return 'persp_hold_body_missing';
      if (!holdParallelOK) return 'persp_hold_not_parallel';
      if (!holdWidthOK) return 'persp_hold_width_not_scaled';
      return true;
    } catch (e) {
      div.remove();
      return String((e && e.message) || e);
    }
  };
}

createRoot(document.getElementById('root')).render(<App />);
