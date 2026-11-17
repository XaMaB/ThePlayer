/** AVC picture boundaries from ITU-T H.264 7.4.1.2.4. No third-party parser. */
export class BitReader {
  private bit = 0;
  constructor(private bytes: Uint8Array) {}
  read(count: number): number {
    if (count < 0 || count > 32 || this.bit + count > this.bytes.length * 8)
      throw new Error('Truncated AVC syntax');
    let value = 0;
    while (count--) {
      value =
        value * 2 + ((this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (!this.read(1))
      if (++zeros > 30) throw new Error('Invalid AVC Exp-Golomb');
    return 2 ** zeros - 1 + this.read(zeros);
  }
  se(): number {
    const n = this.ue();
    return n & 1 ? (n + 1) / 2 : -n / 2;
  }
}
export function rbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0)
      continue;
    out.push(nal[i]);
  }
  return new Uint8Array(out);
}
interface Sps {
  id: number;
  frameBits: number;
  pocType: number;
  pocBits: number;
  separate: boolean;
  frames: boolean;
  deltaZero: boolean;
  frameDuration?: number;
}
interface Pps {
  id: number;
  sps: number;
  bottom: boolean;
}
export interface Picture {
  order?: number;
  frame: number;
  pps: number;
  field: boolean;
  bottom: boolean;
  reference: boolean;
  idr: boolean;
  idrId: number;
  pocType: number;
  poc: number;
  pocBits: number;
  deltaBottom: number;
  delta0: number;
  delta1: number;
  b: boolean;
  frameDuration?: number;
}
function sps(nal: Uint8Array): Sps {
  const b = new BitReader(rbsp(nal));
  const profile = b.read(8);
  b.read(16);
  const id = b.ue();
  if (id > 31) throw new Error('Invalid AVC SPS id');
  let separate = false;
  if (
    [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(
      profile,
    )
  ) {
    const chroma = b.ue();
    if (chroma > 3) throw new Error('Invalid AVC chroma format');
    if (chroma === 3) separate = !!b.read(1);
    b.ue();
    b.ue();
    b.read(1);
    if (b.read(1))
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++)
        if (b.read(1)) {
          let last = 8,
            next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next) next = (last + b.se() + 256) % 256;
            last = next || last;
          }
        }
  }
  const frameBits = b.ue() + 4,
    pocType = b.ue();
  let pocBits = 0,
    deltaZero = false;
  if (pocType === 0) pocBits = b.ue() + 4;
  else if (pocType === 1) {
    deltaZero = !!b.read(1);
    b.se();
    b.se();
    const count = b.ue();
    if (count > 255) throw new Error('Invalid AVC POC cycle');
    for (let i = 0; i < count; i++) b.se();
  } else if (pocType !== 2) throw new Error('Invalid AVC POC type');
  if (frameBits > 16 || pocBits > 16)
    throw new Error('Invalid AVC clock widths');
  b.ue();
  b.read(1);
  b.ue();
  b.ue();
  const frames = !!b.read(1);
  if (!frames) b.read(1);
  b.read(1);
  if (b.read(1)) {
    b.ue();
    b.ue();
    b.ue();
    b.ue();
  }
  let frameDuration: number | undefined;
  if (b.read(1)) {
    if (b.read(1) && b.read(8) === 255) {
      b.read(16);
      b.read(16);
    }
    if (b.read(1)) b.read(1);
    if (b.read(1)) {
      b.read(3);
      b.read(1);
      if (b.read(1)) b.read(24);
    }
    if (b.read(1)) {
      b.ue();
      b.ue();
    }
    if (b.read(1)) {
      const units = b.read(32),
        scale = b.read(32);
      b.read(1);
      if (units && scale) frameDuration = (180000 * units) / scale;
    }
  }
  return {
    id,
    frameBits,
    pocType,
    pocBits,
    separate,
    frames,
    deltaZero,
    frameDuration,
  };
}
function pps(nal: Uint8Array): Pps {
  const b = new BitReader(rbsp(nal)),
    id = b.ue(),
    seq = b.ue();
  if (id > 255 || seq > 31) throw new Error('Invalid AVC PPS id');
  b.read(1);
  return { id, sps: seq, bottom: !!b.read(1) };
}
export class AvcPictures {
  private order = new Map<number, { lsb: number; msb: number }>();
  resetOrder() {
    this.order.clear();
  }
  private sequences = new Map<number, Sps>();
  private pictures = new Map<number, Pps>();
  parameter(nal: Uint8Array) {
    if ((nal[0] & 31) === 7) {
      const value = sps(nal);
      this.sequences.set(value.id, value);
    }
    if ((nal[0] & 31) === 8) {
      const value = pps(nal);
      this.pictures.set(value.id, value);
    }
  }
  picture(nal: Uint8Array): Picture {
    const b = new BitReader(rbsp(nal));
    b.ue();
    const type = b.ue() % 5,
      id = b.ue();
    const p = this.pictures.get(id),
      s = p && this.sequences.get(p.sps);
    if (!s || !p) throw new Error('Missing AVC picture parameter set');
    if (s.separate) b.read(2);
    const frame = b.read(s.frameBits),
      field = !s.frames && !!b.read(1),
      bottom = field && !!b.read(1);
    const idr = (nal[0] & 31) === 5,
      idrId = idr ? b.ue() : 0;
    let poc = 0,
      deltaBottom = 0,
      delta0 = 0,
      delta1 = 0;
    if (s.pocType === 0) {
      poc = b.read(s.pocBits);
      if (p.bottom && !field) deltaBottom = b.se();
    }
    if (s.pocType === 1 && !s.deltaZero) {
      delta0 = b.se();
      if (p.bottom && !field) delta1 = b.se();
    }
    let order: number | undefined;
    if (s.pocType === 0) {
      const previous = idr
        ? { lsb: 0, msb: 0 }
        : (this.order.get(s.id) ?? { lsb: 0, msb: 0 });
      const modulus = 2 ** s.pocBits;
      let msb = previous.msb;
      if (poc < previous.lsb && previous.lsb - poc >= modulus / 2)
        msb += modulus;
      else if (poc > previous.lsb && poc - previous.lsb > modulus / 2)
        msb -= modulus;
      order = msb + poc;
      if (nal[0] & 0x60) this.order.set(s.id, { lsb: poc, msb });
    }
    return {
      order,
      frame,
      pps: id,
      field,
      bottom,
      reference: !!(nal[0] & 0x60),
      idr,
      idrId,
      pocType: s.pocType,
      pocBits: s.pocBits,
      poc,
      deltaBottom,
      delta0,
      delta1,
      b: type === 1,
      frameDuration: s.frameDuration,
    };
  }
}
export function newPicture(a: Picture, b: Picture): boolean {
  return (
    a.frame !== b.frame ||
    a.pps !== b.pps ||
    a.field !== b.field ||
    (a.field && b.field && a.bottom !== b.bottom) ||
    a.reference !== b.reference ||
    a.idr !== b.idr ||
    (a.idr && a.idrId !== b.idrId) ||
    (a.pocType === 0 &&
      b.pocType === 0 &&
      (a.poc !== b.poc || a.deltaBottom !== b.deltaBottom)) ||
    (a.pocType === 1 &&
      b.pocType === 1 &&
      (a.delta0 !== b.delta0 || a.delta1 !== b.delta1))
  );
}
