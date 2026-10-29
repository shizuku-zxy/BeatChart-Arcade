// ============ 可复现伪随机数生成器（mulberry32） ============

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 基于 RNG 的工具
export function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    seed,
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // 加权随机：items = [{v, w}]
    weighted(items) {
      let total = 0;
      for (const it of items) total += it.w;
      let r = next() * total;
      for (const it of items) {
        r -= it.w;
        if (r <= 0) return it.v;
      }
      return items[items.length - 1].v;
    },
  };
}

export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
}
