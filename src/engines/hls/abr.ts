/** Original conservative throughput/buffer policy. All rates are bits per second. */
export class AbrController {
  private fast = 0;
  private slow = 0;
  samples = 0;
  private lastSwitch = -Infinity;
  private lastDecision = -Infinity;
  get estimate() {
    return Math.min(this.fast, this.slow);
  }
  observe(bytes: number, elapsedMs: number) {
    if (bytes <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    const seconds = Math.max(0.05, elapsedMs / 1000),
      rate = (bytes * 8) / seconds;
    const update = (value: number, halfLife: number) => {
      const weight = 1 - Math.pow(0.5, seconds / halfLife);
      return value ? value + weight * (rate - value) : rate;
    };
    this.fast = update(this.fast, 2);
    this.slow = update(this.slow, 8);
    this.samples++;
  }
  switched(now: number) {
    this.lastSwitch = now;
  }
  choose(
    levels: { bandwidth: number }[],
    current: number,
    buffer: number,
    target: number,
    now: number,
  ): number {
    if (this.samples < 2 || now - this.lastDecision < 1000 || !levels[current])
      return current;
    this.lastDecision = now;
    const budget = this.estimate * 0.75;
    let candidate = 0;
    for (let i = 0; i < levels.length; i++)
      if (levels[i].bandwidth <= budget) candidate = i;
    if (candidate < current) return candidate;
    // Recover buffer first, then require headroom and a cooldown before stepping up.
    if (
      candidate > current &&
      buffer >= Math.min(6, target / 2) &&
      now - this.lastSwitch >= 8000
    )
      return Math.min(current + 1, candidate);
    return current;
  }
}
