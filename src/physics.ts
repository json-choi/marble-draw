import { mulberry32 } from "./rng";
import type { MapData } from "./map";

// Fixed step: the race is a pure function of (seed, roster, map), never of frame rate.
export const DT = 1 / 240;
const G = 880;
const VMAX = 1150;
const E_BALL = 0.4;
const SCELL = 64;
export const GATE_T = 3.2; // countdown before the gate drops

export const Ev = { Peg: 0, Bumper: 1, Rotor: 2, Finish: 3, Seg: 4 } as const;
export type EvKind = (typeof Ev)[keyof typeof Ev];
export type SimEvent = { k: EvKind; x: number; y: number; s: number; i: number; id: number };
export type Effect = { k: "shock" | "dash" | "wind"; x: number; y: number; t0: number; dur: number; dir: number; r: number; ball: number };

export class World {
  readonly map: MapData;
  readonly n: number;
  readonly R: number;
  x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array;
  done: Uint8Array;
  best: Float64Array; stuck: Float32Array;
  boostUntil: Float32Array;
  finishOrder: number[] = [];
  finishT: number[] = [];
  t = 0;
  gateOpen = false;
  events: SimEvent[] = [];
  effects: Effect[] = [];
  pegHit: Float32Array; segHit: Float32Array; rotorHit: Float32Array;
  private rnd: () => number;
  private eventsOn: boolean;
  private nextEvt = GATE_T + 3;
  private wind: Effect | null = null;
  // static broadphase
  private sCols: number; private sRows: number; private sCells: Int32Array[];
  // rotors near each static cell, in rotor order, so a ball only tests the windmills it can reach
  private rCells: Int32Array[];
  private allRotors: Int32Array;
  // ball broadphase
  private bCell: number; private bCols: number; private bRows: number;
  private head: Int32Array; private nxt: Int32Array; private cellOf: Int32Array;
  private used: Int32Array; private usedN = 0;
  // rotor arms in world space, refreshed every step
  rArms: Float64Array[];
  rAng: Float64Array;
  private crossing: number[] = [];

  constructor(map: MapData, R: number, seed: number, eventsOn: boolean, slotOfBall: Int32Array) {
    this.map = map;
    this.n = slotOfBall.length;
    this.R = R;
    const n = this.n;
    this.x = new Float64Array(n); this.y = new Float64Array(n);
    this.vx = new Float64Array(n); this.vy = new Float64Array(n);
    this.done = new Uint8Array(n);
    this.best = new Float64Array(n); this.stuck = new Float32Array(n);
    this.boostUntil = new Float32Array(n);
    this.rnd = mulberry32(seed ^ 0x9e3779b9);
    for (let i = 0; i < n; i++) {
      const s = slotOfBall[i];
      this.x[i] = map.slots[s * 2] + (this.rnd() - 0.5) * 0.6;
      this.y[i] = map.slots[s * 2 + 1];
      this.best[i] = this.y[i];
    }
    this.eventsOn = eventsOn;
    this.pegHit = new Float32Array(map.pegs.length).fill(-9);
    this.segHit = new Float32Array(map.segs.length).fill(-9);
    this.rotorHit = new Float32Array(map.rotors.length).fill(-9);
    this.rArms = map.rotors.map((r) => new Float64Array(r.arms.length));
    this.rAng = Float64Array.from(map.rotors.map((r) => r.a));

    this.sCols = Math.ceil(map.W / SCELL) + 1;
    this.sRows = Math.ceil((map.H + 500) / SCELL) + 1;
    this.sCells = [];
    const tmp: number[][] = Array.from({ length: this.sCols * this.sRows }, () => []);
    const pad = R + 2;
    const add = (id: number, x0: number, y0: number, x1: number, y1: number) => {
      const c0 = Math.max(0, Math.floor((x0 - pad) / SCELL)), c1 = Math.min(this.sCols - 1, Math.floor((x1 + pad) / SCELL));
      const r0 = Math.max(0, Math.floor((y0 - pad) / SCELL)), r1 = Math.min(this.sRows - 1, Math.floor((y1 + pad) / SCELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) tmp[r * this.sCols + c].push(id);
    };
    map.pegs.forEach((p, i) => add(i, p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r));
    map.segs.forEach((s, j) => {
      // walls run the whole height; they are handled by a clamp instead
      if (s.x1 === s.x2 && (s.x1 === 0 || s.x1 === map.W)) return;
      add(-(j + 1), Math.min(s.x1, s.x2) - s.t, Math.min(s.y1, s.y2) - s.t, Math.max(s.x1, s.x2) + s.t, Math.max(s.y1, s.y2) + s.t);
    });
    for (let k = 0; k < tmp.length; k++) this.sCells.push(Int32Array.from(tmp[k]));
    const rtmp: number[][] = Array.from({ length: this.sCols * this.sRows }, () => []);
    map.rotors.forEach((ro, r) => {
      const lim = ro.len + R + ro.t + 1;
      const c0 = Math.max(0, Math.floor((ro.cx - lim) / SCELL)), c1 = Math.min(this.sCols - 1, Math.floor((ro.cx + lim) / SCELL));
      const r0 = Math.max(0, Math.floor((ro.cy - lim) / SCELL)), r1 = Math.min(this.sRows - 1, Math.floor((ro.cy + lim) / SCELL));
      for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) rtmp[y * this.sCols + x].push(r);
    });
    const empty = new Int32Array(0);
    this.rCells = rtmp.map((a) => (a.length ? Int32Array.from(a) : empty));
    this.allRotors = Int32Array.from(map.rotors.map((_, r) => r));

    this.bCell = 2 * R + 0.5;
    this.bCols = Math.ceil(map.W / this.bCell) + 2;
    this.bRows = Math.ceil((map.H + 600) / this.bCell) + 2;
    this.head = new Int32Array(this.bCols * this.bRows).fill(-1);
    this.nxt = new Int32Array(n);
    this.cellOf = new Int32Array(n);
    this.used = new Int32Array(n);
  }

  get active() { return this.n - this.finishOrder.length; }
  rand() { return this.rnd(); }

  step() {
    const dt = DT, R = this.R, map = this.map, n = this.n;
    const { x, y, vx, vy, done } = this;
    this.t += dt;
    const t = this.t;
    if (!this.gateOpen && t >= GATE_T) this.gateOpen = true;
    if (this.gateOpen && this.eventsOn && t >= this.nextEvt) this.fireEvent();
    const wind = this.wind && t < this.wind.t0 + this.wind.dur ? this.wind : null;

    for (let r = 0; r < map.rotors.length; r++) {
      const ro = map.rotors[r];
      const ang = (this.rAng[r] += ro.w * dt);
      const c = Math.cos(ang), s = Math.sin(ang), a = ro.arms, o = this.rArms[r];
      for (let k = 0; k < a.length; k += 2) {
        o[k] = ro.cx + a[k] * c - a[k + 1] * s;
        o[k + 1] = ro.cy + a[k] * s + a[k + 1] * c;
      }
    }

    const W = map.W;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      let bvx = vx[i], bvy = vy[i] + G * dt;
      if (wind && Math.abs(y[i] - wind.y) < wind.r) bvx += wind.dir * 1900 * dt;
      const sp2 = bvx * bvx + bvy * bvy;
      if (sp2 > VMAX * VMAX) {
        const k = VMAX / Math.sqrt(sp2);
        bvx *= k; bvy *= k;
      }
      vx[i] = bvx * 0.9997; vy[i] = bvy * 0.9997;
      x[i] += vx[i] * dt; y[i] += vy[i] * dt;

      // statics
      const cc = Math.floor(x[i] / SCELL), cr = Math.floor(y[i] / SCELL);
      if (cc >= 0 && cc < this.sCols && cr >= 0 && cr < this.sRows) {
        const ids = this.sCells[cr * this.sCols + cc];
        for (let q = 0; q < ids.length; q++) {
          const id = ids[q];
          if (id >= 0) this.hitPeg(i, id);
          else this.hitSeg(i, -id - 1);
        }
      }
      if (!this.gateOpen) {
        const g = map.gate;
        if (y[i] > g.y1 - R - g.t) {
          y[i] = g.y1 - R - g.t;
          if (vy[i] > 0) vy[i] = -vy[i] * g.e;
        }
      }
      // the ball may have moved while resolving statics, so look its cell up again
      const rc = Math.floor(x[i] / SCELL), rr = Math.floor(y[i] / SCELL);
      const near = rc >= 0 && rc < this.sCols && rr >= 0 && rr < this.sRows ? this.rCells[rr * this.sCols + rc] : this.allRotors;
      for (let q = 0; q < near.length; q++) {
        const r = near[q];
        const ro = map.rotors[r];
        const dx = x[i] - ro.cx, dy = y[i] - ro.cy, lim = ro.len + R + ro.t;
        if (dx * dx + dy * dy > lim * lim) continue;
        const o = this.rArms[r];
        for (let k = 0; k < o.length; k += 4) {
          const hit = this.collideCapsule(i, o[k], o[k + 1], o[k + 2], o[k + 3], ro.t, 0.35, ro.w, ro.cx, ro.cy);
          if (hit > 0) {
            this.rotorHit[r] = t;
            if (hit > 260) this.events.push({ k: Ev.Rotor, x: x[i], y: y[i], s: hit, i, id: r });
          }
        }
        // hub
        const hd2 = dx * dx + dy * dy, hr = R + 12;
        if (hd2 < hr * hr) this.pushOutCircle(i, ro.cx, ro.cy, 12, 0.4, 0);
      }
      if (x[i] < R) { x[i] = R; if (vx[i] < 0) vx[i] = -vx[i] * 0.45; }
      else if (x[i] > W - R) { x[i] = W - R; if (vx[i] > 0) vx[i] = -vx[i] * 0.45; }
      if (y[i] < -380) { y[i] = -380; if (vy[i] < 0) vy[i] = 0; }
    }

    this.collideBalls();

    // finish line and the unsticker
    const goal = map.goalY;
    this.crossing.length = 0;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      if (y[i] >= goal) { this.crossing.push(i); continue; }
      if (!this.gateOpen) continue;
      if (y[i] > this.best[i] + 2) { this.best[i] = y[i]; this.stuck[i] = 0; }
      else if ((this.stuck[i] += dt) > 3.5) {
        this.stuck[i] = 1.6;
        vx[i] += (this.rnd() - 0.5) * 900;
        vy[i] -= 250 + this.rnd() * 350;
      }
    }
    if (this.crossing.length) {
      if (this.crossing.length > 1) this.crossing.sort((a, b) => y[b] - y[a] || a - b);
      for (const i of this.crossing) {
        done[i] = 1;
        this.finishOrder.push(i);
        this.finishT.push(t);
        this.events.push({ k: Ev.Finish, x: x[i], y: goal, s: 0, i, id: this.finishOrder.length });
      }
    }
  }

  private hitPeg(i: number, id: number) {
    const p = this.map.pegs[id];
    const s = this.pushOutCircle(i, p.x, p.y, p.r, p.e, p.kick);
    if (s > 0) {
      const t = this.t;
      if (p.kick > 0) {
        if (t - this.pegHit[id] > 0.05) this.events.push({ k: Ev.Bumper, x: p.x, y: p.y, s, i, id });
      } else if (s > 180 && t - this.pegHit[id] > 0.08) this.events.push({ k: Ev.Peg, x: p.x, y: p.y, s, i, id });
      this.pegHit[id] = t;
    }
  }

  private hitSeg(i: number, j: number) {
    const s = this.map.segs[j];
    const hit = this.collideCapsule(i, s.x1, s.y1, s.x2, s.y2, s.t, s.e, 0, 0, 0);
    if (hit > 0) {
      if (hit > 300 && this.t - this.segHit[j] > 0.1) this.events.push({ k: Ev.Seg, x: this.x[i], y: this.y[i], s: hit, i, id: j });
      this.segHit[j] = this.t;
    }
  }

  // returns the normal impact speed (0 when not touching)
  private pushOutCircle(i: number, cx: number, cy: number, r: number, e: number, kick: number): number {
    const dx = this.x[i] - cx, dy = this.y[i] - cy;
    const rr = r + this.R;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return 0;
    let d = Math.sqrt(d2), nx: number, ny: number;
    if (d < 1e-6) { nx = 0; ny = -1; d = 0; } else { nx = dx / d; ny = dy / d; }
    this.x[i] = cx + nx * rr;
    this.y[i] = cy + ny * rr;
    const vn = this.vx[i] * nx + this.vy[i] * ny;
    if (vn >= 0) return 1e-3;
    let out = -vn * e;
    if (kick > 0) out = Math.max(out, kick);
    this.vx[i] += (out - vn) * nx;
    this.vy[i] += (out - vn) * ny;
    return -vn;
  }

  // capsule from (ax,ay) to (bx,by) of half-thickness th; w/ox/oy = rotation of a moving arm
  private collideCapsule(i: number, ax: number, ay: number, bx: number, by: number, th: number, e: number, w: number, ox: number, oy: number): number {
    const px = this.x[i], py = this.y[i];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let u = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const cx = ax + u * dx, cy = ay + u * dy;
    let nx = px - cx, ny = py - cy;
    const rr = this.R + th;
    const d2 = nx * nx + ny * ny;
    if (d2 >= rr * rr) return 0;
    const d = Math.sqrt(d2);
    if (d < 1e-6) {
      const l = Math.sqrt(L2) || 1;
      nx = -dy / l; ny = dx / l;
      if (ny > 0) { nx = -nx; ny = -ny; }
    } else { nx /= d; ny /= d; }
    this.x[i] = cx + nx * rr;
    this.y[i] = cy + ny * rr;
    // surface velocity of a spinning arm at the contact point
    const svx = w ? -w * (cy - oy) : 0, svy = w ? w * (cx - ox) : 0;
    let rvx = this.vx[i] - svx, rvy = this.vy[i] - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 1e-3;
    rvx -= (1 + e) * vn * nx;
    rvy -= (1 + e) * vn * ny;
    // a whisker of friction along the surface so rolling balls do not skate forever
    const tx = -ny, ty = nx, vt = rvx * tx + rvy * ty;
    rvx -= vt * 0.0015 * tx; rvy -= vt * 0.0015 * ty;
    this.vx[i] = rvx + svx;
    this.vy[i] = rvy + svy;
    return -vn;
  }

  private collideBalls() {
    const { x, y, vx, vy, done, head, nxt, cellOf, used } = this;
    const n = this.n, cs = this.bCell, cols = this.bCols, rows = this.bRows;
    for (let k = 0; k < this.usedN; k++) head[used[k]] = -1;
    this.usedN = 0;
    for (let i = 0; i < n; i++) {
      if (done[i]) { cellOf[i] = -1; continue; }
      let c = Math.floor(x[i] / cs) + 1, r = Math.floor((y[i] + 500) / cs) + 1;
      c = c < 0 ? 0 : c >= cols ? cols - 1 : c;
      r = r < 0 ? 0 : r >= rows ? rows - 1 : r;
      const cell = r * cols + c;
      cellOf[i] = cell;
      if (head[cell] === -1) used[this.usedN++] = cell;
      nxt[i] = head[cell];
      head[cell] = i;
    }
    const D = 2 * this.R, D2 = D * D, total = cols * rows;
    // pairs in a fixed order (own cell, then right, lower-left, lower, lower-right) keep the race reproducible
    for (let i = 0; i < n; i++) {
      const cell = cellOf[i];
      if (cell < 0) continue;
      const c = cell % cols;
      for (let q = -1; q < 4; q++) {
        let j: number;
        if (q < 0) j = nxt[i];
        else {
          const nc = q === 0 ? cell + 1 : cell + cols - 2 + q;
          if ((q === 0 || q === 3) && c === cols - 1) continue;
          if (q === 1 && c === 0) continue;
          if (nc >= total) continue;
          j = head[nc];
        }
        for (; j !== -1; j = nxt[j]) {
          let dx = x[j] - x[i], dy = y[j] - y[i];
          let d2 = dx * dx + dy * dy;
          if (d2 >= D2) continue;
          if (d2 < 1e-8) { dx = (((i * 7 + j) % 5) - 2) * 0.01 + 0.005; dy = 0.01; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          const corr = (D - d) * 0.5;
          x[i] -= nx * corr; y[i] -= ny * corr;
          x[j] += nx * corr; y[j] += ny * corr;
          const rvn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
          if (rvn < 0) {
            const imp = -(1 + E_BALL) * rvn * 0.5;
            vx[i] -= imp * nx; vy[i] -= imp * ny;
            vx[j] += imp * nx; vy[j] += imp * ny;
          }
        }
      }
    }
  }

  private pickBall(): number {
    for (let tries = 0; tries < 30; tries++) {
      const i = Math.floor(this.rnd() * this.n);
      if (!this.done[i] && this.y[i] > this.map.gateY) return i;
    }
    return -1;
  }

  private fireEvent() {
    this.nextEvt = this.t + 2.6 + this.rnd() * 3.2;
    const i = this.pickBall();
    if (i < 0) return;
    const roll = this.rnd();
    const t = this.t;
    if (roll < 0.4) {
      // dash: one ball gets a burst
      this.vy[i] = Math.max(this.vy[i], 0) + 950;
      this.vx[i] += (this.rnd() - 0.5) * 400;
      this.boostUntil[i] = t + 1.2;
      this.effects.push({ k: "dash", x: this.x[i], y: this.y[i], t0: t, dur: 1.2, dir: 0, r: 0, ball: i });
    } else if (roll < 0.75) {
      // shockwave around a random ball
      const cx = this.x[i], cy = this.y[i], rad = 230;
      for (let j = 0; j < this.n; j++) {
        if (this.done[j]) continue;
        const dx = this.x[j] - cx, dy = this.y[j] - cy, d = Math.hypot(dx, dy);
        if (d > rad || d < 1) continue;
        const f = 1000 * (1 - d / rad);
        this.vx[j] += (dx / d) * f; this.vy[j] += (dy / d) * f;
      }
      this.effects.push({ k: "shock", x: cx, y: cy, t0: t, dur: 0.7, dir: 0, r: rad, ball: i });
    } else {
      // gust across a band
      const dir = this.rnd() < 0.5 ? -1 : 1;
      this.wind = { k: "wind", x: this.map.W / 2, y: this.y[i], t0: t, dur: 1.6, dir, r: 260, ball: i };
      this.effects.push(this.wind);
    }
  }
}
