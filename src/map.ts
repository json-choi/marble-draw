// Board layouts. World units: the board is W wide, y grows downward toward the finish line.
// Every gap is wider than the largest ball (radius RMAX) so nothing can wedge for good.
export const W = 1000;
export const RMAX = 15;

export type Peg = { x: number; y: number; r: number; e: number; kick: number; hue: number };
export type Seg = { x1: number; y1: number; x2: number; y2: number; t: number; e: number; hue: number };
export type Rotor = { cx: number; cy: number; w: number; a: number; arms: number[]; t: number; len: number; hue: number };
export type Section = { y0: number; y1: number; name: string; hue: number };

export type MapData = {
  id: MapId;
  W: number;
  H: number;
  pegs: Peg[];
  segs: Seg[];
  rotors: Rotor[];
  sections: Section[];
  goalY: number;
  gateY: number;
  gate: Seg;
  slots: Float64Array; // hopper lattice: x,y per slot, bottom row first
};

export type MapId = "meteor" | "windmill" | "chaos";
export type MapLength = "short" | "normal" | "long";

export const MAPS: { id: MapId; name: string; desc: string; hue: number }[] = [
  { id: "meteor", name: "유성 폭포", desc: "핀 숲과 풍차, 갈림길을 고루 지나는 기본 코스", hue: 200 },
  { id: "windmill", name: "풍차 언덕", desc: "크고 작은 풍차가 계속 판을 뒤섞는 코스", hue: 150 },
  { id: "chaos", name: "네온 카오스", desc: "범퍼가 튕겨 내는 역전이 잦은 코스", hue: 320 },
];

class Builder {
  pegs: Peg[] = [];
  segs: Seg[] = [];
  rotors: Rotor[] = [];
  sections: Section[] = [];
  peg(x: number, y: number, hue: number, r = 5, e = 0.45, kick = 0) {
    this.pegs.push({ x, y, r, e, kick, hue });
  }
  seg(x1: number, y1: number, x2: number, y2: number, hue: number, t = 4, e = 0.25) {
    this.segs.push({ x1, y1, x2, y2, t, e, hue });
  }
  rotor(cx: number, cy: number, armCount: number, len: number, w: number, hue: number, a = 0) {
    const arms: number[] = [];
    for (let k = 0; k < armCount; k++) {
      const ang = (k / armCount) * Math.PI * 2;
      arms.push(0, 0, Math.cos(ang) * len, Math.sin(ang) * len);
    }
    this.rotors.push({ cx, cy, w, a, arms, t: 6, len, hue });
  }
}

type SectionFn = (b: Builder, y: number, hue: number) => number; // returns height used
type Part = { name: string; fn: SectionFn };

const pegField = (rows: number): Part => ({
  name: "핀 숲",
  fn: (b, y, hue) => {
    const sx = 74, sy = 60;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? sx / 2 : 0;
      for (let x = 66 + off; x <= W - 66; x += sx) b.peg(x, y + 40 + r * sy, hue);
    }
    return rows * sy + 50;
  },
});

const spinners = (count: number, arms: number): Part => ({
  name: "풍차",
  fn: (b, y, hue) => {
    const sp = W / count;
    const L = Math.min(96, sp / 2 - 44);
    const cy = y + L + 50;
    for (let i = 0; i < count; i++) {
      const dir = i % 2 ? 1 : -1;
      b.rotor(sp * (i + 0.5), cy, arms, L, dir * (1.9 + (i % 3) * 0.45), hue, i * 0.7);
      if (i < count - 1) b.peg(sp * (i + 1), cy, hue, 5);
    }
    return 2 * L + 110;
  },
});

const bumpers = (): Part => ({
  name: "범퍼",
  fn: (b, y, hue) => {
    for (let r = 0; r < 3; r++) {
      const count = r % 2 ? 4 : 5;
      for (let j = 0; j < count; j++) b.peg((W / (count + 1)) * (j + 1), y + 80 + r * 150, hue, 27, 0.6, 760);
    }
    for (let j = 0; j < 6; j++) b.peg((W / 6) * (j + 0.5), y + 460, hue, 5);
    return 520;
  },
});

const zigzag = (levels: number): Part => ({
  name: "지그재그",
  fn: (b, y, hue) => {
    const g = 210, drop = 90, lh = 205;
    for (let k = 0; k < levels; k++) {
      const yk = y + 50 + k * lh;
      if (k % 2 === 0) b.seg(0, yk, W - g, yk + drop, hue, 5, 0.15);
      else b.seg(W, yk, g, yk + drop, hue, 5, 0.15);
    }
    return levels * lh + 80;
  },
});

const lanes = (): Part => ({
  name: "갈림길",
  fn: (b, y, hue) => {
    const top = y + 40, bot = y + 560;
    for (const x of [200, 400, 600, 800]) b.seg(x, top, x, bot, hue, 4, 0.3);
    // lane 0: dense pins
    for (let r = 0; r < 8; r++) {
      const off = r % 2 ? 25 : 0;
      for (let x = 50 + off; x <= 150; x += 50) b.peg(x, top + 50 + r * 58, hue, 4);
    }
    // lane 1: a small windmill
    b.rotor(300, top + 260, 2, 56, 3.2, hue);
    // lane 2: the open lane, guarded by one bumper
    b.peg(500, top + 130, hue, 24, 0.6, 820);
    // lane 3: arrows
    for (let r = 0; r < 4; r++) {
      const cx = r % 2 ? 690 : 710, cy = top + 70 + r * 115;
      b.seg(cx - 40, cy + 26, cx, cy, hue, 4);
      b.seg(cx, cy, cx + 40, cy + 26, hue, 4);
    }
    // lane 4: shelves
    for (let r = 0; r < 4; r++) {
      const yy = top + 60 + r * 120;
      if (r % 2 === 0) b.seg(800, yy, 920, yy + 36, hue, 4, 0.15);
      else b.seg(1000, yy, 880, yy + 36, hue, 4, 0.15);
    }
    return 620;
  },
});

const chevrons = (rows: number): Part => ({
  name: "화살 비탈",
  fn: (b, y, hue) => {
    for (let r = 0; r < rows; r++) {
      const cy = y + 50 + r * 120;
      const xs = r % 2 ? [215, 405, 595, 785] : [120, 310, 500, 690, 880];
      for (const cx of xs) {
        b.seg(cx - 58, cy + 34, cx, cy, hue, 4);
        b.seg(cx, cy, cx + 58, cy + 34, hue, 4);
      }
    }
    return rows * 120 + 70;
  },
});

const wheel = (dir: number): Part => ({
  name: "대풍차",
  fn: (b, y, hue) => {
    const L = 228;
    const cy = y + L + 60;
    b.rotor(W / 2, cy, 3, L, dir * 1.15, hue);
    for (let r = 0; r < 5; r++) {
      b.peg(70, cy - 180 + r * 90, hue, 6);
      b.peg(W - 70, cy - 180 + r * 90, hue, 6);
    }
    return 2 * L + 130;
  },
});

const LAYOUTS: Record<MapId, Part[]> = {
  meteor: [pegField(8), spinners(4, 4), bumpers(), zigzag(3), pegField(6), lanes(), chevrons(4), wheel(1), pegField(5)],
  windmill: [spinners(4, 4), pegField(6), spinners(5, 2), wheel(-1), chevrons(3), spinners(3, 3), zigzag(2), lanes(), wheel(1), pegField(5)],
  chaos: [bumpers(), chevrons(3), lanes(), bumpers(), spinners(4, 2), zigzag(4), bumpers(), pegField(6)],
};

export function ballRadius(n: number): number {
  if (n <= 30) return 15;
  if (n <= 100) return 13;
  if (n <= 250) return 11;
  if (n <= 500) return 9.5;
  return 8;
}

export function buildMap(id: MapId, length: MapLength, n: number, R: number): MapData {
  const b = new Builder();
  const baseHue = MAPS.find((m) => m.id === id)!.hue;

  // hopper: a hex lattice resting on the gate
  const pitch = 2 * R + 2.5;
  const rowH = pitch * 0.87;
  const perRow = Math.floor((W - 30 - pitch / 2) / pitch);
  const rows = Math.max(1, Math.ceil(n / perRow));
  const gateY = Math.max(260, rows * rowH + 120);
  const slots = new Float64Array(n * 2);
  for (let s = 0; s < n; s++) {
    const row = Math.floor(s / perRow), col = s % perRow;
    const rowCount = Math.min(perRow, n - row * perRow);
    const span = (rowCount - 1) * pitch + (row % 2 ? pitch / 2 : 0);
    slots[s * 2] = W / 2 - span / 2 + col * pitch + (row % 2 ? pitch / 2 : 0);
    slots[s * 2 + 1] = gateY - R - 4 - row * rowH;
  }
  b.sections.push({ y0: 0, y1: gateY, name: "출발", hue: baseHue });

  let parts = LAYOUTS[id];
  if (length === "short") parts = parts.slice(0, Math.ceil(parts.length * 0.55));
  else if (length === "long") parts = [...parts, ...parts.slice(1, -1)];

  let y = gateY + 30;
  parts.forEach((p, i) => {
    const hue = (baseHue + i * 38) % 360;
    const h = p.fn(b, y, hue);
    b.sections.push({ y0: y, y1: y + h, name: p.name, hue });
    y += h;
  });
  // run-in to the line
  for (let j = 0; j < 7; j++) b.peg(W / 7 * (j + 0.5), y + 40, 45, 5);
  const goalY = y + 150;
  b.sections.push({ y0: y, y1: goalY + 260, name: "결승", hue: 45 });
  const H = goalY + 260;
  b.seg(0, -400, 0, H, baseHue, 6, 0.3);
  b.seg(W, -400, W, H, baseHue, 6, 0.3);
  const gate: Seg = { x1: 0, y1: gateY, x2: W, y2: gateY, t: 6, e: 0.1, hue: 50 };
  return { id, W, H, pegs: b.pegs, segs: b.segs, rotors: b.rotors, sections: b.sections, goalY, gateY, gate, slots };
}
