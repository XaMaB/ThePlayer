/** Assemble complete CMAF moof/mdat units across arbitrary HTTP chunk boundaries. */
export class CmafChunks {
  private pending = new Uint8Array(0);
  private boxes: Uint8Array[] = [];
  private size = 0;
  private moof = false;
  push(data: Uint8Array): Uint8Array[] {
    if (this.pending.length + data.length + this.size > 32 * 1024 * 1024)
      throw new Error('DASH CMAF chunk exceeds 32 MiB');
    const joined = new Uint8Array(this.pending.length + data.length);
    joined.set(this.pending);
    joined.set(data, this.pending.length);
    this.pending = joined;
    const output: Uint8Array[] = [];
    let at = 0;
    while (this.pending.length - at >= 8) {
      const view = new DataView(
        this.pending.buffer,
        this.pending.byteOffset + at,
      );
      let length = view.getUint32(0),
        header = 8;
      if (length === 1) {
        if (this.pending.length - at < 16) break;
        const extended = view.getBigUint64(8);
        if (extended > 32n * 1024n * 1024n)
          throw new Error('DASH CMAF extended box exceeds limit');
        length = Number(extended);
        header = 16;
      }
      if (length < header || length > 32 * 1024 * 1024)
        throw new Error('Invalid DASH CMAF box size');
      if (this.pending.length - at < length) break;
      const type = String.fromCharCode(
        ...this.pending.subarray(at + 4, at + 8),
      );
      if (type === 'moof') {
        if (this.moof) throw new Error('DASH CMAF moof has no mdat');
        this.moof = true;
      }
      if (type === 'mdat' && !this.moof)
        throw new Error('DASH CMAF mdat has no moof');
      this.boxes.push(this.pending.slice(at, at + length));
      this.size += length;
      at += length;
      if (type === 'mdat') {
        const unit = new Uint8Array(this.size);
        let offset = 0;
        for (const box of this.boxes) {
          unit.set(box, offset);
          offset += box.length;
        }
        output.push(unit);
        this.boxes = [];
        this.size = 0;
        this.moof = false;
      }
    }
    this.pending = this.pending.slice(at);
    return output;
  }
  finish() {
    if (this.pending.length || this.moof)
      throw new Error('Truncated DASH CMAF response');
    // A trailing complete index/event box carries no media samples.
    this.boxes = [];
    this.size = 0;
  }
}
