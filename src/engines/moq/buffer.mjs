// Measurements use the media clock for GOP/fragment duration and the monotonic
// receive clock for delivery jitter. All durations returned here are seconds.
export function fragmentTiming(bytes, timescale) {
  if (!Number.isFinite(timescale) || timescale <= 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function boxes(start, end) {
    const out = [];
    for (let p = start; p < end; ) {
      if (p + 8 > end) throw Error('Truncated box');
      let size = view.getUint32(p),
        h = 8;
      if (size === 1) {
        if (p + 16 > end) throw Error('Truncated large box');
        size = Number(view.getBigUint64(p + 8));
        h = 16;
      }
      if (size === 0) size = end - p;
      if (!Number.isSafeInteger(size) || size < h || p + size > end)
        throw Error('Invalid box');
      out.push({
        type: String.fromCharCode(...bytes.subarray(p + 4, p + 8)),
        body: p + h,
        end: p + size,
      });
      p += size;
    }
    return out;
  }
  try {
    let start = null,
      end = null;
    const keyframes = [];
    for (const moof of boxes(0, bytes.length).filter((b) => b.type === 'moof'))
      for (const traf of boxes(moof.body, moof.end).filter(
        (b) => b.type === 'traf',
      )) {
        const children = boxes(traf.body, traf.end),
          hd = children.find((b) => b.type === 'tfhd'),
          dt = children.find((b) => b.type === 'tfdt');
        if (!hd || !dt) return null;
        let p = hd.body,
          flags = view.getUint32(p) & 0xffffff;
        p += 8;
        if (flags & 1) p += 8;
        if (flags & 2) p += 4;
        let duration = null,
          sampleFlags = 0;
        if (flags & 8) {
          duration = view.getUint32(p);
          p += 4;
        }
        if (flags & 16) p += 4;
        if (flags & 32) {
          sampleFlags = view.getUint32(p);
          p += 4;
        }
        if (p > hd.end) return null;
        let dts =
          bytes[dt.body] === 1
            ? Number(view.getBigUint64(dt.body + 4))
            : view.getUint32(dt.body + 4);
        if (!Number.isSafeInteger(dts)) return null;
        start = start === null ? dts : Math.min(start, dts);
        for (const run of children.filter((b) => b.type === 'trun')) {
          p = run.body;
          flags = view.getUint32(p) & 0xffffff;
          const count = view.getUint32(p + 4);
          p += 8;
          if (count > 200000) return null;
          if (flags & 1) p += 4;
          let first;
          if (flags & 4) {
            first = view.getUint32(p);
            p += 4;
          }
          for (let i = 0; i < count; i++) {
            let dur = duration,
              f = i === 0 && first !== undefined ? first : sampleFlags;
            if (flags & 0x100) {
              dur = view.getUint32(p);
              p += 4;
            }
            if (flags & 0x200) p += 4;
            if (flags & 0x400) {
              f = view.getUint32(p);
              p += 4;
            }
            if (flags & 0x800) p += 4;
            if (p > run.end || dur === null) return null;
            // A declared zero-duration field is valid timing metadata. Keep its sync
            // flag and DTS; later samples can carry the remaining duration. Missing
            // duration defaults are different and must not be guessed.
            // Explicit independent/sync samples; do not treat unknown flags as keyframes.
            if (!(f & 0x10000) && ((f >>> 24) & 3) === 2)
              keyframes.push(dts / timescale);
            dts += dur;
          }
        }
        end = end === null ? dts : Math.max(end, dts);
      }
    return start !== null && end > start
      ? {
          start: start / timescale,
          end: end / timescale,
          duration: (end - start) / timescale,
          keyframes,
        }
      : null;
  } catch {
    return null;
  }
}
const percentile = (a, p) => {
  const s = [...a].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * p) - 1)] ?? 0;
};
export class AdaptiveBuffer {
  /** @param {{targetSeconds?:number|null}} [options] */
  constructor({ targetSeconds = null } = {}) {
    this.fixedTarget = targetSeconds;
    this.target = targetSeconds ?? 1;
    this.gop = 0;
    this.fragment = 0;
    this.jitter = 0;
    this.stalls = 0;
    this.durations = [];
    this.gops = [];
    this.delays = [];
    this.last = null;
    this.lastKey = null;
    this.lastStall = -Infinity;
  }
  observe(timing, arrival) {
    if (!timing || !Number.isFinite(arrival) || timing.duration <= 0) return;
    if (this.last && timing.end <= this.last.end) return; // replayed/older groups aren't arrival jitter
    this.durations.push(timing.duration);
    this.durations = this.durations.slice(-12);
    for (const key of timing.keyframes) {
      if (this.lastKey !== null && key > this.lastKey) {
        const span = key - this.lastKey;
        if (span <= 30) this.gops.push(span);
      }
      if (this.lastKey === null || key > this.lastKey) this.lastKey = key;
    }
    this.gops = this.gops.slice(-12);
    const elapsed = this.last
      ? Math.max(0, (arrival - this.last.arrival) / 1000)
      : 0;
    if (this.last) {
      // Bursts from relay cache have negative excess delay and add no artificial jitter.
      this.delays.push(Math.max(0, elapsed - (timing.end - this.last.end)));
      this.delays = this.delays.slice(-20);
    }
    this.gop = percentile(this.gops, 0.9);
    this.fragment = percentile(this.durations, 0.9);
    this.jitter = percentile(this.delays, 0.95);
    // Exactly two measured GOPs. Fragment duration is only a startup fallback
    // until two sync samples establish a GOP interval. Jitter is diagnostic only.
    this.target = this.fixedTarget ?? 2 * (this.gop || this.fragment);
    this.last = { end: timing.end, arrival };
  }
  underflow(now) {
    if (now - this.lastStall < 10000) return;
    this.lastStall = now;
    this.stalls++;
  }
  snapshot() {
    return {
      mode: this.fixedTarget === null ? 'two-gop' : 'cache-reserve',
      target: this.target,
      gop: this.gop,
      fragment: this.fragment,
      jitter: this.jitter,
      rebufferCount: this.stalls,
    };
  }
}
