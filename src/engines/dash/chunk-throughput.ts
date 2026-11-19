/** Measure transfer inside complete CMAF units, excluding producer waits between units. */
export class ChunkThroughput {
  private started?: number;
  private pending = 0;
  bytes = 0;
  elapsed = 0;
  samples = 0;
  observe(bytes: number, completeBytes: number, now: number) {
    this.started ??= now;
    this.pending += bytes;
    if (completeBytes > this.pending)
      throw new Error('Invalid CMAF throughput accounting');
    if (!completeBytes) return;
    const elapsed = now - this.started;
    // Single-callback units have no measurable transfer duration. Do not turn
    // timer precision into an arbitrarily large bandwidth estimate.
    if (elapsed >= 5 && completeBytes >= 16384) {
      this.bytes += completeBytes;
      this.elapsed += elapsed;
      this.samples++;
    }
    this.pending -= completeBytes;
    this.started = this.pending ? now : undefined;
  }
}
