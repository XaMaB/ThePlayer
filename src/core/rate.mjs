// Average published bytes over a rolling window, independently for each channel instance.
export class PublishedRate {
  constructor(windowMs = 20000) {
    this.windowMs = windowMs;
    this.samples = [];
    this.key = null;
  }
  update(key, bytes, now) {
    if (
      key !== this.key ||
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      this.samples.at(-1)?.bytes > bytes
    ) {
      this.key = key;
      this.samples = [];
    }
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    if (this.samples.length && now <= this.samples.at(-1).at) return null;
    this.samples.push({ at: now, bytes });
    while (this.samples.length > 2 && this.samples[1].at <= now - this.windowMs)
      this.samples.shift();
    const first = this.samples[0],
      elapsed = now - first.at;
    return elapsed > 0 ? ((bytes - first.bytes) * 8) / elapsed / 1000 : null;
  }
}
