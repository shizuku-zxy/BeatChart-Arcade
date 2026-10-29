// ============ SongPlayer 纯时间换算（Node 可测：tests/test-core.mjs 直接断言） ============
//
// v1.7.0 手录谱慢放/回退的核心公式。约定：
//   - "音乐时间" = 音频内容自身的时间轴（0 = 音乐开头），与播放速率无关；
//   - wall = ctx.currentTime - startedAtCtx（墙钟流逝秒数）；
//   - 慢放 rate=0.5 时墙钟走 1 秒音乐只前进 0.5 秒——录入时刻即音乐时间轴时刻，
//     录出的谱在正常速度播放时对位不变。

/**
 * 当前音乐时间。
 * @param {number} startMusicT 本段起点的音乐时间（可为负 = 倒计时段）
 * @param {number|null} startedAtCtx 本段起点对应的 ctx.currentTime（null = 暂停/未开播）
 * @param {number} ctxNow 当前 ctx.currentTime
 * @param {number} rate 播放速率（0.5/0.75/1…）
 */
export function musicTimeAt(startMusicT, startedAtCtx, ctxNow, rate) {
  if (startedAtCtx == null) return startMusicT;
  // v1.7.1：不再钳制负 wall——play 锚定在调用时刻（过去），墙钟回拨只在
  // ctx.currentTime 读取竞态时出现（微秒级），钳制反而会把倒计时冻住。
  return startMusicT + (ctxNow - startedAtCtx) * rate;
}

/**
 * play(leadSec, fromT) 的段起点锚定：倒计时期间 time 从 fromT - rate*lead 起算，
 * 音频恰好在音乐时间 fromT 处开始出声（倒计时墙钟时长恒为 lead 秒）。
 */
export function playAnchorMusicT(fromT, leadSec, rate) {
  return Math.max(0, fromT) - rate * Math.max(0, leadSec);
}

/**
 * 透视式深度曲线（v1.8.1d：恢复 v1.8.0 幂函数基线，推翻 1.8.1b/c 曲线族）。
 * 决策依据（2026-10-29，用户反馈"不如之前的1.8版本"）：
 *   - Quaver 源码实证（ScrollNoteController.GetSpritePosition）：下落式行业共识
 *     = 位置与时间严格线性（匀速+可调间距）；
 *   - 透视式属 pjsk/SDVX 流派，正确模型 = 3D 匀速移动 + 透视投影；
 *     幂函数 (K/(dt+K))^0.62 即"软化透视投影"（0.62 为 v1.5.2 调优值），
 *     就是用户认可的 1.8 手感本体；
 *   - 1.8.1 三连改的真正病灶是【可见窗口被动了】（8K→15K→2K）：
 *     note 出现到判定的时长缩水 4 倍（L5 下 5.4s→1.35s），反应时间损失
 *     才是"不如之前"的主因。曲线形状是次要因素。
 * 因此本函数与渲染上限 8K 必须成套恢复，之后任何微调只动指数单变量。
 * @param dt 距判定线的剩余时间（秒，负=过线外推）
 * @param approach 判定 approach（= speedToApproach）
 * @param power 软化指数（0.62 = v1.5.2/v1.8.0 手感基线；越小越匀速方向）
 */
export function perspQ(dt, approach, power = 0.62) {
  const K = approach;
  // 分母下限 0.02：防御性防 NaN（若日后 K 可小于 0.16，负数幂会产生 NaN）
  const q = Math.pow(K / Math.max(0.02, Math.max(-0.16, dt) + K), power);
  return Math.min(1.6, q);
}

/**
 * 透视式可见窗口时长（v1.8.1g：窗口回 8K，纯函数可单测）。
 * v1.8.1f 曾扩到 12K（L10=2.4s），用户试后要求回到 8K（L10=1.6s，
 * 即 v1.8.0 基线窗口）；保留 1.6s 绝对下限保 L11-15 高速档不低于基线。
 * 近端冲刺速度由 approach 决定，不受窗口影响。
 * @param approach 判定 approach（= speedToApproach）
 * @param minLead 窗口绝对下限（秒）；1.6 = L10 玩家基线
 */
export function visibleLeadTime(approach, minLead = 1.6) {
  return Math.max(approach * 8, minLead);
}
