import { BitReader, rbsp, type Picture } from './avc-access';
interface Sequence {
  id: number;
  separate: boolean;
  pocBits: number;
}
interface Parameters {
  id: number;
  sps: number;
  output: boolean;
  extra: number;
}
/** HEVC first-slice POC metadata; remaining slices stay in the same access unit. */
export class HevcPictures {
  private order = new Map<number, { lsb: number; msb: number }>();
  resetOrder() {
    this.order.clear();
  }
  private sequences = new Map<number, Sequence>();
  private pictures = new Map<number, Parameters>();
  parameter(nal: Uint8Array) {
    const type = (nal[0] >> 1) & 63;
    if (type !== 33 && type !== 34) return;
    const b = new BitReader(rbsp(nal.subarray(1)));
    if (type === 34) {
      const id = b.ue(),
        sps = b.ue();
      b.read(1);
      if (id > 63 || sps > 15) throw new Error('Invalid HEVC PPS id');
      this.pictures.set(id, { id, sps, output: !!b.read(1), extra: b.read(3) });
      return;
    }
    b.read(4);
    const layers = b.read(3);
    b.read(1);
    if (layers > 6) throw new Error('Invalid HEVC temporal layers');
    for (let i = 0; i < 12; i++) b.read(8);
    const sub = Array.from({ length: layers }, () => [b.read(1), b.read(1)]);
    if (layers) b.read((8 - layers) * 2);
    for (const [profile, level] of sub) {
      if (profile) for (let i = 0; i < 11; i++) b.read(8);
      if (level) b.read(8);
    }
    const id = b.ue(),
      chroma = b.ue();
    if (id > 15 || chroma > 3) throw new Error('Invalid HEVC SPS');
    const separate = chroma === 3 && !!b.read(1);
    b.ue();
    b.ue();
    if (b.read(1)) {
      b.ue();
      b.ue();
      b.ue();
      b.ue();
    }
    b.ue();
    b.ue();
    const pocBits = b.ue() + 4;
    if (pocBits > 16) throw new Error('Invalid HEVC POC width');
    this.sequences.set(id, { id, separate, pocBits });
  }
  picture(nal: Uint8Array): Picture {
    const type = (nal[0] >> 1) & 63,
      b = new BitReader(rbsp(nal.subarray(1)));
    if (!b.read(1))
      throw new Error('HEVC access unit must begin with its first slice');
    if (type >= 16 && type <= 23) b.read(1);
    const id = b.ue(),
      p = this.pictures.get(id),
      s = p && this.sequences.get(p.sps);
    if (!p || !s) throw new Error('Missing HEVC picture parameter set');
    b.read(p.extra);
    const sliceType = b.ue();
    if (sliceType > 2) throw new Error('Invalid HEVC slice type');
    if (p.output) b.read(1);
    if (s.separate) b.read(2);
    const idr = type === 19 || type === 20;
    const poc = idr ? 0 : b.read(s.pocBits);
    const previous = idr
      ? { lsb: 0, msb: 0 }
      : (this.order.get(s.id) ?? { lsb: 0, msb: 0 });
    const modulus = 2 ** s.pocBits;
    let msb = previous.msb;
    if (type >= 16 && type <= 20) msb = 0;
    else if (poc < previous.lsb && previous.lsb - poc >= modulus / 2)
      msb += modulus;
    else if (poc > previous.lsb && poc - previous.lsb > modulus / 2)
      msb -= modulus;
    if ((nal[1] & 7) === 1 && ![6, 7, 8, 9].includes(type))
      this.order.set(s.id, { lsb: poc, msb });
    return {
      order: msb + poc,
      frame: 0,
      pps: id,
      field: false,
      bottom: false,
      reference: true,
      idr,
      idrId: 0,
      pocType: 0,
      pocBits: s.pocBits,
      poc,
      deltaBottom: 0,
      delta0: 0,
      delta1: 0,
      b: sliceType === 0,
    };
  }
}
