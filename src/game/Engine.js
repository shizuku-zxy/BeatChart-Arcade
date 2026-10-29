// ============ 判定引擎（纯逻辑，与渲染解耦） ============
// 输入时间一律使用 AudioContext.currentTime 基准的歌曲时间（已扣除延迟校准）

import { JUDGE_WINDOWS, JUDGE_SCORE_WEIGHT, HOLD_RELEASE_GRACE } from '../core/constants.js';

export class JudgeEngine {
  /**
   * @param {Array} notes 谱面 notes（升序）
   * @param {object} opts { onJudge(note, judge, isTail), onFinish(stats) }
   */
  constructor(notes, opts = {}) {
    this.opts = opts;
    // state: pending | judged | holding | done | broken；hold 另有 tailState
    this.notes = notes.map((n) => ({ ...n, state: 'pending', tailState: 'pending' }));
    this.idx = 0;                 // 下一个待判定 note 指针
    this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this.weightSum = 0;
    this.judgeCount = 0;
    this.totalJudges = notes.reduce((s, n) => s + (n.type === 'hold' ? 2 : 1), 0);
    this.finished = false;
  }

  /** 输入偏差 → 判定等级（null = 窗口外） */
  judgeFor(dt) {
    const a = Math.abs(dt);
    if (a <= JUDGE_WINDOWS.perfect) return 'perfect';
    if (a <= JUDGE_WINDOWS.great) return 'great';
    if (a <= JUDGE_WINDOWS.good) return 'good';
    return null;
  }

  applyJudge(note, judge, isTail, offset) {
    this.counts[judge]++;
    this.judgeCount++;
    this.weightSum += JUDGE_SCORE_WEIGHT[judge];
    if (judge === 'miss') this.combo = 0;
    else { this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); }
    if (this.opts.onJudge) this.opts.onJudge(note, judge, isTail, offset);
  }

  get accuracy() {
    return this.totalJudges ? (this.weightSum / this.totalJudges) * 100 : 100;
  }
  get score() {
    // 900k 准确率 + 100k 连击达成
    const accPart = 900000 * (this.totalJudges ? this.weightSum / this.totalJudges : 1);
    const comboPart = 100000 * (this.totalJudges ? this.maxCombo / this.totalJudges : 1);
    return Math.round(accPart + comboPart);
  }
  get fullCombo() { return this.counts.miss === 0 && this.judgeCount > 0; }

  /** keydown：判定该轨道最早处于窗口内的 pending note；broken hold 可重新按住恢复（v1.5.0） */
  handleKeyDown(lane, time) {
    for (let i = this.idx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t - time > JUDGE_WINDOWS.good) break;   // 后面的 note 更远，无需再看
      if (n.lane !== lane) continue;
      // 断开的长键：按住即恢复（不产生判定；尾部到点时按是否按住给判定）
      if (n.state === 'broken' && time <= n.t + n.d + 0.12) {
        n.state = 'holding';
        return 'resume';
      }
      if (n.state !== 'pending') continue;
      const judge = this.judgeFor(time - n.t);
      if (judge) {
        n.state = n.type === 'hold' ? 'holding' : 'judged';
        this.applyJudge(n, judge, false, time - n.t);
        return judge;
      }
      break; // 窗口外（早按过多）→ 后面同轨 note 更远，直接放弃
    }
    return null;
  }

  /** keyup：hold 提前松手检测（v1.5.0：宽容期内给判定；超出宽容期只断开不立即判，可重新按住恢复） */
  handleKeyUp(lane, time) {
    for (let i = this.idx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > time + 0.5) break;
      if (n.lane !== lane || n.state !== 'holding') continue;
      const early = (n.t + n.d) - time;             // 尾部剩余时间
      if (early > HOLD_RELEASE_GRACE) {
        // 明显早松：断开（可恢复）；尾部判定延迟到尾点时刻（期间重新按住则无损）
        n.state = 'broken';
      } else {
        // 宽容期内松手：按提前量给判定（超出 good 的部分判 good）
        n.state = 'done';
        n.tailState = this.judgeFor(early) || 'good';
        this.applyJudge(n, n.tailState, true, -early);
      }
    }
  }

  /** 每帧调用：处理 miss 与 hold 尾自然完成 */
  update(time) {
    // miss 扫描：pending 且超过 good 窗口
    for (let i = this.idx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t - time > JUDGE_WINDOWS.good) break;
      if (n.state === 'pending' && time - n.t > JUDGE_WINDOWS.good) {
        n.state = 'judged';
        this.applyJudge(n, 'miss', false, time - n.t);
        if (n.type === 'hold') { n.tailState = 'miss'; this.applyJudge(n, 'miss', true, time - n.t); }
      }
    }
    // hold 尾自然完成（仍按住）
    for (let i = this.idx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > time) break;
      if (n.state === 'holding' && time >= n.t + n.d) {
        n.state = 'done';
        n.tailState = 'perfect';
        this.applyJudge(n, 'perfect', true, 0);
      }
      // 断开且未恢复的长键：过尾点（含 0.12s 恢复余量）后补判尾部 miss
      if (n.state === 'broken' && n.tailState === 'pending' && time > n.t + n.d + 0.12) {
        n.tailState = 'miss';
        this.applyJudge(n, 'miss', true, time - (n.t + n.d));
      }
    }
    // 推进 idx（跳过完全处理的头部）
    while (this.idx < this.notes.length) {
      const n = this.notes[this.idx];
      const done = n.state === 'judged' || n.state === 'done' || n.state === 'broken';
      if (done && (n.type !== 'hold' || n.tailState !== 'pending')) this.idx++;
      else break;
    }
    if (!this.finished && this.judgeCount >= this.totalJudges) {
      this.finished = true;
      if (this.opts.onFinish) this.opts.onFinish(this.getStats());
    }
  }

  getStats() {
    return {
      score: this.score,
      accuracy: +this.accuracy.toFixed(2),
      counts: { ...this.counts },
      maxCombo: this.maxCombo,
      totalJudges: this.totalJudges,
      fullCombo: this.fullCombo,
    };
  }
}
