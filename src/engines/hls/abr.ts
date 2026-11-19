export interface AbrOptions {
  /** Initial Auto quality within the compatible ladder. Default: lowest. */
  startup?: 'lowest' | 'highest';
  /** Step one level at a time or jump to the measured bandwidth budget. */
  upswitch?: 'stepwise' | 'direct';
}

/** Original conservative throughput/buffer policy. All rates are bits per second. */
export class AbrController {
  readonly options: Readonly<Required<AbrOptions>>;
  constructor(options: AbrOptions = {}) {
    const startup = options.startup ?? 'lowest';
    const upswitch = options.upswitch ?? 'stepwise';
    if (
      !['lowest', 'highest'].includes(startup) ||
      !['stepwise', 'direct'].includes(upswitch)
    )
      throw new Error('Invalid ABR startup or upswitch policy');
    this.options = Object.freeze({ startup, upswitch });
  }
  initialIndex(levels: { bandwidth: number }[]): number {
    return this.options.startup === 'highest'
      ? Math.max(0, levels.length - 1)
      : 0;
  }

  private blocked = new Map<
    number,
    { until: number; strikes: number; reason: string }
  >();
  quarantine(index: number, now: number, reason: string) {
    const strikes = Math.min(4, (this.blocked.get(index)?.strikes ?? 0) + 1);
    this.blocked.set(index, {
      until: now + Math.min(180000, 30000 * 2 ** (strikes - 1)),
      strikes,
      reason,
    });
  }
  clear(index: number) {
    this.blocked.delete(index);
  }
  quarantined(now: number) {
    return Array.from(this.blocked, ([index, value]) => ({
      index,
      ...value,
    })).filter((value) => value.until > now);
  }
  private available(index: number, now: number) {
    return (this.blocked.get(index)?.until ?? 0) <= now;
  }
  fallback(
    levels: { bandwidth: number }[],
    current: number,
    now: number,
  ): number | undefined {
    for (let i = current - 1; i >= 0; i--)
      if (levels[i] && this.available(i, now)) return i;
  }
  emergency(
    levels: { bandwidth: number }[],
    current: number,
    progress: { loaded: number; total?: number; elapsedMs: number },
    buffer: number,
    duration: number,
    now: number,
  ): number | undefined {
    if (current <= 0 || progress.elapsedMs < 1000) return;
    const elapsed = progress.elapsedMs / 1000;
    if (!progress.loaded && elapsed < Math.max(1.5, buffer / 2)) return;
    const rate = (progress.loaded * 8) / elapsed;
    const expected =
      progress.total ?? (levels[current].bandwidth * duration) / 8;
    const remaining = rate
      ? (Math.max(0, expected - progress.loaded) * 8) / rate
      : Infinity;
    if (remaining <= Math.max(0.5, buffer - 0.25)) return;
    const lowest = levels.findIndex((_, i) => this.available(i, now));
    for (let i = current - 1; i >= 0; i--) {
      if (!this.available(i, now)) continue;
      if (
        !rate ||
        ((levels[i].bandwidth <= rate * 0.75 || i === lowest) &&
          (levels[i].bandwidth * duration) / rate + 0.2 < remaining * 0.8)
      )
        return i;
    }
  }

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
    let candidate = levels.findIndex((_, i) => this.available(i, now));
    if (candidate < 0) return current;
    for (let i = 0; i < levels.length; i++)
      if (levels[i].bandwidth <= budget && this.available(i, now))
        candidate = i;
    if (candidate < current) return candidate;
    // Both upgrade modes retain buffer headroom, quarantine and cooldown guards.
    if (
      candidate > current &&
      buffer >= Math.min(6, target / 2) &&
      now - this.lastSwitch >= 8000
    ) {
      if (this.options.upswitch === 'direct') return candidate;
      for (let i = current + 1; i <= candidate; i++)
        if (this.available(i, now)) return i;
    }
    return current;
  }
}

export class EmergencySwitch extends Error {
  constructor(readonly index: number) {
    super('Slow HLS resource risks buffer exhaustion');
    this.name = 'EmergencySwitch';
  }
}
