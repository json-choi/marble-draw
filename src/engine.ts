import { World, DT, GATE_T, Ev } from "./physics";
import { buildMap, ballRadius, MAPS, type MapData, type MapId, type MapLength } from "./map";
import { mulberry32, permutation } from "./rng";
import { paletteColor, shortLabel, PALETTE_SIZE, type Roster } from "./parse";
import { Sound } from "./audio";

export type RuleMode = "first" | "last" | "nth";
export type Rule = { mode: RuleMode; nth: number; count: number };
export type SetupOpts = { roster: Roster; mapId: MapId; length: MapLength; seed: number; rule: Rule; events: boolean; slowmo: boolean };
export type Phase = "empty" | "preview" | "countdown" | "racing" | "done";
export type Winner = { place: number; rank: number; ball: number; name: string; color: string; time: number; arrived: boolean };
export type Leader = { ball: number; name: string; color: string; rank: number; done: boolean };
export type Hud = {
  phase: Phase; countdown: number; elapsed: number; finished: number; total: number;
  leaders: Leader[]; follow: boolean; paused: boolean; speed: number; slow: boolean; target: string | null;
};
type Callbacks = { onHud: (h: Hud) => void; onWinner: (w: Winner) => void; onDone: (ws: Winner[]) => void };

const MAX_PARTICLES = 2400;
const MINIMAP_W = 46;
const FONT = '"Pretendard Variable", Pretendard, system-ui, sans-serif';
const BG = "#0a0c13";
const ACCENT = "#f2c14e";
// spark colors are bucketed so hundreds of sparks become a few dozen strokes
const SPARK_HUES = 24, SPARK_ALPHAS = 4, SPARK_KEYS = SPARK_HUES * SPARK_ALPHAS;
const SPARK_STYLE = Array.from({ length: SPARK_KEYS }, (_, k) => {
  const h = (Math.floor(k / SPARK_ALPHAS) + 0.5) * (360 / SPARK_HUES), a = ((k % SPARK_ALPHAS) + 0.5) / SPARK_ALPHAS;
  return `hsla(${h.toFixed(0)} 70% 70% / ${a.toFixed(2)})`;
});
const CONFETTI_STYLE = Array.from({ length: 12 }, (_, k) => `hsl(${k * 30} 82% 62%)`);
const STAR_STYLE = ["rgba(200,212,235,0.22)", "rgba(200,212,235,0.34)", "rgba(220,228,245,0.5)"];
const STAR_Z = [0.14, 0.3, 0.5];

export class Engine {
  readonly sound = new Sound();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: Callbacks;
  private raf = 0;
  private last = 0;
  private cw = 0; private ch = 0; private dpr = 1;
  private opts: SetupOpts | null = null;
  map: MapData | null = null;
  world: World | null = null;
  private R = 10;
  phase: Phase = "empty";
  // preview / shuffle animation
  private slotOf: Int32Array = new Int32Array(0);
  private fromX = new Float64Array(0); private fromY = new Float64Array(0);
  private shuffleT = 1;
  // time
  private acc = 0;
  speed = 1;
  paused = false;
  private slow = 1; private zoom = 1;
  private hitstop = 0;
  // camera
  private camX = 500; private camY = 0;
  follow = true;
  private shake = 0;
  // winners
  private targets: number[] = [];
  winners: Winner[] = [];
  private order: Int32Array = new Int32Array(0); // unfinished balls by progress
  private orderN = 0;
  private lastCount = -1;
  // visuals
  private sprites: HTMLCanvasElement[] = [];
  private glows = new Map<number, HTMLCanvasElement>();
  private bumperSprites = new Map<number, HTMLCanvasElement>();
  private stars: { x: number; y: number; s: number }[][] = [[], [], []];
  // balls with their names baked in, so 1000 labels cost 1000 image copies instead of 2000 text draws
  private atlas: HTMLCanvasElement | null = null;
  private atlasKey = "";
  private atlasCell = 0; private atlasCols = 1;
  private atlasSlot = new Int32Array(0);
  private byColor: Int32Array[] = [];
  private styles = new Map<number, string>();
  private secStyle: { band: string; name: string; mini: string }[] = [];
  // the course is one material, faintly tinted per course; the color belongs to the marbles
  private tint = 210;
  private sparkCount = new Int32Array(SPARK_KEYS + 1);
  private sparkOrder = new Int32Array(MAX_PARTICLES);
  private vignette: CanvasGradient | null = null;
  private drawSig = "";
  private trails = new Map<number, number[]>();
  private px = new Float32Array(MAX_PARTICLES); private py = new Float32Array(MAX_PARTICLES);
  private pvx = new Float32Array(MAX_PARTICLES); private pvy = new Float32Array(MAX_PARTICLES);
  private plife = new Float32Array(MAX_PARTICLES); private pmax = new Float32Array(MAX_PARTICLES);
  private phue = new Float32Array(MAX_PARTICLES); private pkind = new Uint8Array(MAX_PARTICLES);
  private prot = new Float32Array(MAX_PARTICLES);
  private pn = 0;
  private flash = 0;
  private time = 0;
  private hudT = 0;
  private lastCountdown = -1;
  private pops: { x: number; y: number; text: string; t: number; hue: number }[] = [];
  // pointer
  private drag: { x: number; y: number; cx: number; cy: number; mini: boolean } | null = null;
  // recording
  private rec: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private ro: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, cb: Callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.cb = cb;
    const rnd = mulberry32(42);
    for (let k = 0; k < 180; k++) this.stars[k % 3].push({ x: rnd(), y: rnd(), s: 0.6 + rnd() * 1.4 });
    this.makeSprites();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.sound.stopMusic();
    void this.sound.ctx?.close();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = Math.max(1, r.width);
    this.ch = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
    this.vignette = null;
    this.drawSig = "";
    if (this.opts && this.map) this.buildAtlas();
  }

  // ---------- setup ----------
  setup(o: SetupOpts) {
    const keepSlots = this.opts && this.map && this.opts.roster.names.length === o.roster.names.length && this.opts.seed === o.seed && this.opts.mapId === o.mapId && this.opts.length === o.length;
    this.opts = o;
    this.world = null;
    this.winners = [];
    this.trails.clear();
    this.pn = 0;
    this.pops = [];
    const n = o.roster.names.length;
    if (!n) {
      this.phase = "empty";
      this.map = null;
      return;
    }
    this.R = ballRadius(n);
    this.map = buildMap(o.mapId, o.length, n, this.R);
    this.prepMap();
    this.buildAtlas();
    this.phase = "preview";
    this.drawSig = "";
    const slots = permutation(n, mulberry32(o.seed));
    if (keepSlots && this.slotOf.length === n) {
      this.slotOf = slots;
    } else {
      this.slotOf = slots;
      this.fromX = new Float64Array(n);
      this.fromY = new Float64Array(n);
      this.shuffleT = 1;
    }
    this.follow = true;
    this.camY = this.previewCamY();
    this.emitHud(true);
  }

  // re-seat the balls with a fly-over animation
  shuffleTo(seed: number) {
    if (!this.opts || !this.map || this.phase !== "preview") return;
    const n = this.slotOf.length;
    const t = this.shuffleEase();
    for (let i = 0; i < n; i++) {
      const [x, y] = this.previewPos(i, t);
      this.fromX[i] = x;
      this.fromY[i] = y;
    }
    this.opts = { ...this.opts, seed };
    this.slotOf = permutation(n, mulberry32(seed));
    this.shuffleT = 0;
    this.drawSig = "";
    this.sound.ensure();
    this.sound.whoosh();
  }

  private shuffleEase() {
    const t = Math.min(1, this.shuffleT);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  private previewPos(i: number, e: number): [number, number] {
    const m = this.map!;
    const s = this.slotOf[i];
    const tx = m.slots[s * 2], ty = m.slots[s * 2 + 1];
    if (e >= 1) return [tx, ty];
    const fx = this.fromX[i], fy = this.fromY[i];
    const arc = Math.sin(e * Math.PI) * (80 + ((i * 37) % 120));
    return [fx + (tx - fx) * e, fy + (ty - fy) * e - arc];
  }

  private previewCamY() {
    const m = this.map;
    if (!m) return 0;
    const { viewH } = this.view();
    return Math.max(viewH / 2 - 60, m.gateY - viewH * 0.32);
  }

  start() {
    const o = this.opts, m = this.map;
    if (!o || !m) return;
    this.sound.ensure();
    if (this.sound.musicOn) this.sound.startMusic();
    // a fresh board every run, so a replay with the same seed is the same race
    this.map = buildMap(o.mapId, o.length, this.slotOf.length, this.R);
    this.prepMap();
    this.world = new World(this.map, this.R, o.seed, o.events, this.slotOf);
    this.phase = "countdown";
    this.winners = [];
    this.trails.clear();
    this.pops = [];
    this.acc = 0;
    this.slow = 1;
    this.zoom = 1;
    this.paused = false;
    this.follow = true;
    this.lastCountdown = -1;
    this.lastCount = -1;
    const n = this.slotOf.length;
    this.order = new Int32Array(n);
    const r = o.rule;
    const k = Math.max(1, Math.min(r.count, n));
    if (r.mode === "first") this.targets = Array.from({ length: k }, (_, j) => j + 1);
    else if (r.mode === "nth") {
      const s = Math.max(1, Math.min(r.nth, n));
      this.targets = Array.from({ length: Math.min(k, n - s + 1) }, (_, j) => s + j);
    } else this.targets = Array.from({ length: k }, (_, j) => n - j);
    this.emitHud(true);
  }

  stop() {
    this.stopRecording();
    this.sound.stopMusic();
    if (this.opts) this.setup(this.opts);
  }

  setPaused(p: boolean) { this.paused = p; this.emitHud(true); }
  setSpeed(s: number) { this.speed = s; this.emitHud(true); }
  setFollow() { this.follow = true; this.emitHud(true); }

  nameOf(i: number) { return this.opts?.roster.names[i] ?? ""; }
  colorOf(i: number) { return paletteColor(this.opts?.roster.colorIdx[i] ?? 0).css; }
  finishOrder(): number[] { return this.world?.finishOrder ?? []; }
  finishTime(k: number) { const w = this.world; return w ? w.finishT[k] - GATE_T : 0; }

  // ---------- recording ----------
  startRecording(): boolean {
    if (this.rec || typeof MediaRecorder === "undefined") return false;
    const stream = this.canvas.captureStream(60);
    this.sound.ensure();
    const ad = this.sound.recordDest;
    if (ad) for (const tr of ad.stream.getAudioTracks()) stream.addTrack(tr);
    const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    try {
      this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
    } catch {
      return false;
    }
    this.recChunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.recChunks.push(e.data);
    this.rec.onstop = () => {
      const type = this.rec?.mimeType || "video/webm";
      const blob = new Blob(this.recChunks, { type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      a.download = `구슬추첨-${stamp}.${type.includes("mp4") ? "mp4" : "webm"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.rec = null;
    };
    this.rec.start(500);
    return true;
  }
  stopRecording() {
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
  }
  get recording() { return !!this.rec; }

  // ---------- sprites ----------
  private makeSprites() {
    const size = 64;
    for (let k = 0; k < PALETTE_SIZE; k++) {
      const { hue } = paletteColor(k);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d")!;
      const r = size / 2 - 1;
      const grad = g.createRadialGradient(size * 0.36, size * 0.32, r * 0.08, size / 2, size / 2, r);
      grad.addColorStop(0, `hsl(${hue} 100% 92%)`);
      grad.addColorStop(0.28, `hsl(${hue} 88% 66%)`);
      grad.addColorStop(0.8, `hsl(${hue} 80% 42%)`);
      grad.addColorStop(1, `hsl(${hue} 75% 24%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(size / 2, size / 2, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.72)";
      g.beginPath();
      g.ellipse(size * 0.37, size * 0.27, r * 0.28, r * 0.16, -0.5, 0, Math.PI * 2);
      g.fill();
      this.sprites.push(c);
    }
  }

  // colors that depend only on the board, worked out once per board instead of every frame
  private prepMap() {
    const m = this.map!;
    this.tint = MAPS.find((x) => x.id === m.id)?.hue ?? 210;
    this.secStyle = m.sections.map((_, k) => ({
      band: k % 2 ? "rgba(238,240,245,0.02)" : "rgba(0,0,0,0)",
      name: "rgba(238,240,245,0.07)",
      mini: k % 2 ? "rgba(238,240,245,0.1)" : "rgba(238,240,245,0.05)",
    }));
    const lists: number[][] = Array.from({ length: PALETTE_SIZE }, () => []);
    this.opts!.roster.colorIdx.forEach((c, i) => lists[c].push(i));
    this.byColor = lists.map((l) => Int32Array.from(l));
  }

  // canvas color strings, built once per (hue, saturation, lightness, alpha)
  private style(h: number, sat: number, light: number, alpha = 1): string {
    const a = Math.round(alpha * 100);
    const key = ((h * 128 + sat) * 128 + light) * 128 + a;
    let v = this.styles.get(key);
    if (!v) { v = `hsla(${h} ${sat}% ${light}% / ${a / 100})`; this.styles.set(key, v); }
    return v;
  }

  private buildAtlas() {
    const o = this.opts!;
    const names = o.roster.names, colors = o.roster.colorIdx, n = names.length;
    const cell = Math.min(96, Math.ceil(this.R * 4 * this.dpr));
    const key = `${cell}|${colors.join(",")}|${names.join("\u0001")}`;
    if (key === this.atlasKey) return;
    this.atlasKey = key;
    const idx = new Map<string, number>();
    const cells: { c: number; label: string }[] = [];
    const slot = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const label = shortLabel(names[i]);
      const k = `${colors[i]}|${label}`;
      let c = idx.get(k);
      if (c === undefined) { c = cells.length; idx.set(k, c); cells.push({ c: colors[i], label }); }
      slot[i] = c;
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(cells.length)));
    const cv = this.atlas ?? document.createElement("canvas");
    cv.width = cols * cell;
    cv.height = Math.max(1, Math.ceil(cells.length / cols)) * cell;
    const g = cv.getContext("2d")!;
    const r = cell / 2;
    const font = (px: number) => `600 ${px.toFixed(1)}px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.fillStyle = "#fff";
    g.lineWidth = Math.max(1.5, r * 0.18);
    cells.forEach(({ c, label }, k) => {
      const x = (k % cols) * cell, y = Math.floor(k / cols) * cell;
      g.drawImage(this.sprites[c], x, y, cell, cell);
      let fs = r * 0.9;
      g.font = font(fs);
      const tw = g.measureText(label).width;
      if (tw > r * 1.84) { fs *= (r * 1.84) / tw; g.font = font(fs); }
      g.strokeText(label, x + r, y + r + 0.5);
      g.fillText(label, x + r, y + r + 0.5);
    });
    this.atlas = cv;
    this.atlasCell = cell;
    this.atlasCols = cols;
    this.atlasSlot = slot;
    this.drawSig = "";
    // web fonts arrive late: bake again once the glyphs are really there
    const sample = cells.slice(0, 200).map((x) => x.label).join("");
    const fonts = document.fonts;
    if (sample && fonts && !fonts.check(font(16), sample)) {
      void fonts.load(font(16), sample).then(() => {
        if (this.atlasKey !== key) return;
        this.atlasKey = "";
        this.buildAtlas();
      }, () => {});
    }
  }

  private glow(hue: number): HTMLCanvasElement {
    const key = Math.round(hue) % 360;
    let c = this.glows.get(key);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `hsla(${key} 40% 88% / 0.7)`);
    grad.addColorStop(0.35, `hsla(${key} 40% 75% / 0.22)`);
    grad.addColorStop(1, `hsla(${key} 40% 60% / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.glows.set(key, c);
    return c;
  }

  private bumper(hue: number): HTMLCanvasElement {
    let c = this.bumperSprites.get(hue);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 96;
    const g = c.getContext("2d")!;
    const r = 47;
    const grad = g.createRadialGradient(48 - r * 0.3, 48 - r * 0.3, r * 0.1, 48, 48, r);
    grad.addColorStop(0, `hsl(${hue} 18% 90%)`);
    grad.addColorStop(0.55, `hsl(${hue} 12% 54%)`);
    grad.addColorStop(1, `hsl(${hue} 14% 22%)`);
    g.fillStyle = grad;
    g.beginPath(); g.arc(48, 48, r, 0, Math.PI * 2); g.fill();
    this.bumperSprites.set(hue, c);
    return c;
  }

  // ---------- particles ----------
  private spawn(x: number, y: number, count: number, hue: number, speed: number, kind = 0, life = 0.6) {
    for (let k = 0; k < count; k++) {
      if (this.pn >= MAX_PARTICLES) return;
      const i = this.pn++;
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      this.px[i] = x; this.py[i] = y;
      this.pvx[i] = Math.cos(a) * s; this.pvy[i] = Math.sin(a) * s - (kind === 1 ? speed * 0.6 : 0);
      this.plife[i] = this.pmax[i] = life * (0.6 + Math.random() * 0.8);
      this.phue[i] = kind === 1 ? Math.random() * 360 : hue + (Math.random() - 0.5) * 30;
      this.pkind[i] = kind;
      this.prot[i] = Math.random() * 6;
    }
  }

  private updateParticles(dt: number) {
    let j = 0;
    for (let i = 0; i < this.pn; i++) {
      const life = this.plife[i] - dt;
      if (life <= 0) continue;
      const kind = this.pkind[i];
      this.plife[j] = life; this.pmax[j] = this.pmax[i];
      this.pvx[j] = this.pvx[i] * (kind === 1 ? 0.985 : 0.95);
      this.pvy[j] = this.pvy[i] * (kind === 1 ? 0.985 : 0.95) + (kind === 1 ? 700 : 300) * dt;
      this.px[j] = this.px[i] + this.pvx[j] * dt;
      this.py[j] = this.py[i] + this.pvy[j] * dt;
      this.phue[j] = this.phue[i]; this.pkind[j] = kind;
      this.prot[j] = this.prot[i] + dt * 8;
      j++;
    }
    this.pn = j;
  }

  // ---------- view ----------
  private view() {
    // wide screens keep the live-ranking card (right side) off the board while racing
    const reserve = this.cw >= 860 && this.world ? 226 : 0;
    const usable = this.cw - MINIMAP_W - 8 - reserve;
    const sFit = usable / 1040;
    // landscape: the whole width fits; portrait phones: zoom in and pan with the action
    const base = usable / this.ch >= 0.8 ? sFit : Math.min(sFit * 1.45, this.ch / 700);
    const s = Math.max(0.2, base) * this.zoom;
    return { s, viewW: usable / s, viewH: this.ch / s, usable };
  }

  // ---------- main loop ----------
  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const rdt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += rdt;
    this.sound.frame();
    if (this.phase === "preview" && this.shuffleT < 1) this.shuffleT = Math.min(1, this.shuffleT + rdt / 1.1);
    const w = this.world;
    if (w && !this.paused) {
      if (this.hitstop > 0) this.hitstop -= rdt;
      else {
        this.acc += rdt * this.speed * this.slow;
        // a slow device plays the race a little slower instead of dropping frames;
        // the race itself is the same, since every step is the same fixed size
        const t0 = performance.now();
        let steps = 0;
        while (this.acc >= DT && steps < 80) {
          w.step();
          this.acc -= DT;
          steps++;
          if ((steps & 3) === 0 && performance.now() - t0 > 8) break;
        }
        if (this.acc > DT * 4) this.acc = DT * 4;
      }
      this.consumeEvents();
      this.rank();
      this.judge();
    }
    this.updateParticles(rdt);
    this.updateCamera(rdt);
    // a settled preview does not change, so it is not painted again
    const idle = !w && this.shuffleT >= 1 && this.pn === 0 && this.flash < 0.01 && this.pops.length === 0 && this.shake === 0;
    const sig = idle ? `${this.camX.toFixed(1)}|${this.camY.toFixed(1)}|${this.zoom.toFixed(3)}` : "";
    if (!idle || sig !== this.drawSig) this.draw();
    this.drawSig = sig;
    this.hudT -= rdt;
    if (this.hudT <= 0) this.emitHud(false);
  };

  private rank() {
    const w = this.world!;
    let k = 0;
    for (let i = 0; i < w.n; i++) if (!w.done[i]) this.order[k++] = i;
    this.orderN = k;
    const y = w.y;
    const sub = this.order.subarray(0, k);
    sub.sort((a, b) => y[b] - y[a] || a - b);
  }

  private nextTarget(): number | null {
    const w = this.world;
    if (!w) return null;
    const mode = this.opts!.rule.mode;
    if (this.winners.length >= this.targets.length) return null;
    if (mode === "last") return this.orderN ? this.order[this.orderN - 1] : null;
    const r = this.targets[this.winners.length];
    const ahead = r - w.finishOrder.length - 1;
    if (ahead < 0 || this.orderN === 0) return null;
    return this.order[Math.min(ahead, this.orderN - 1)];
  }

  private judge() {
    const w = this.world!;
    if (this.phase === "countdown") {
      const c = Math.ceil(GATE_T - w.t);
      if (c !== this.lastCountdown && c > 0 && c <= 3) {
        this.lastCountdown = c;
        this.sound.beep(false);
      }
      if (w.gateOpen) {
        this.phase = "racing";
        this.sound.beep(true);
        this.shake = 10;
        for (let x = 40; x < 1000; x += 60) this.spawn(x, this.map!.gateY, 3, 50, 500);
        this.emitHud(true);
      }
    }
    if (this.phase !== "racing") return;
    const mode = this.opts!.rule.mode;
    const n = w.n;
    const push = (ball: number, rank: number) => {
      const place = this.winners.length + 1;
      const ft = w.finishOrder.indexOf(ball);
      const win: Winner = { place, rank, ball, name: this.nameOf(ball), color: this.colorOf(ball), time: ft >= 0 ? w.finishT[ft] - GATE_T : w.t - GATE_T, arrived: ft >= 0 };
      this.winners.push(win);
      this.cb.onWinner(win);
      this.sound.fanfare();
      this.flash = 1;
      this.shake = 16;
      this.hitstop = 0.35;
      const bx = w.x[ball], by = Math.min(w.y[ball], this.map!.goalY);
      this.spawn(bx, by, 160, 50, 1100, 1, 2.6);
      this.spawn(bx, by, 80, paletteColor(this.opts!.roster.colorIdx[ball]).hue, 900, 0, 1);
      this.pops.push({ x: bx, y: by - 40, text: `${place}번째 당첨`, t: this.time, hue: 50 });
    };
    if (mode === "last") {
      const k = this.targets.length;
      if (w.active <= k && this.winners.length === 0) {
        // the remaining balls can no longer be beaten to the line: they are the last ones
        const rest = Array.from(this.order.subarray(0, this.orderN)).sort((a, b) => w.y[a] - w.y[b]);
        rest.forEach((b, j) => push(b, n - j));
      }
    } else {
      while (this.winners.length < this.targets.length) {
        const r = this.targets[this.winners.length];
        if (w.finishOrder.length < r) break;
        push(w.finishOrder[r - 1], r);
      }
    }
    if (this.winners.length >= this.targets.length) {
      this.phase = "done";
      this.slow = 1;
      this.cb.onDone(this.winners.slice());
      this.emitHud(true);
      if (this.rec) setTimeout(() => this.stopRecording(), 3500);
    }
  }

  private consumeEvents() {
    const w = this.world!;
    const { viewH } = this.view();
    const top = this.camY - viewH / 2 - 100, bot = this.camY + viewH / 2 + 100;
    const map = this.map!;
    let fin = 0;
    for (const e of w.events) {
      const vis = e.y > top && e.y < bot;
      if (e.k === Ev.Finish) {
        fin++;
        if (vis && fin < 6) this.spawn(e.x, e.y, 10, 45, 500, 0, 0.7);
        if (fin < 3) this.sound.chime(e.id);
        continue;
      }
      if (!vis) continue;
      if (e.k === Ev.Bumper) {
        this.spawn(e.x, e.y, 12, 42, 520);
        this.sound.boing(e.s);
      } else if (e.k === Ev.Peg) {
        if (Math.random() < 0.35) this.spawn(e.x, e.y, 2, 42, 260, 0, 0.35);
        this.sound.tick(e.x / map.W, e.s);
      } else if (e.k === Ev.Rotor) {
        if (Math.random() < 0.3) this.spawn(e.x, e.y, 3, 42, 300, 0, 0.4);
        if (Math.random() < 0.2) this.sound.thud();
      } else if (e.k === Ev.Seg) {
        if (Math.random() < 0.15) this.sound.tick(0.2, e.s * 0.5);
      }
    }
    w.events.length = 0;
    for (const f of w.effects) {
      if ((f as { seen?: boolean }).seen) continue;
      (f as { seen?: boolean }).seen = true;
      const vis = f.y > top - 300 && f.y < bot + 300;
      if (f.k === "shock") {
        if (vis) { this.sound.shock(); this.shake = Math.max(this.shake, 8); this.spawn(f.x, f.y, 40, 190, 800); }
        this.pops.push({ x: f.x, y: f.y - 30, text: "충격파", t: this.time, hue: 190 });
      } else if (f.k === "dash") {
        if (vis) this.sound.dash();
        this.pops.push({ x: f.x, y: f.y - 30, text: `${shortLabel(this.nameOf(f.ball))} 대시`, t: this.time, hue: 30 });
      } else {
        if (vis) this.sound.gust();
        this.pops.push({ x: f.dir > 0 ? 700 : 300, y: f.y - f.r * 0.6, text: f.dir > 0 ? "돌풍 →" : "← 돌풍", t: this.time, hue: 160 });
      }
    }
    if (w.effects.length > 12) w.effects = w.effects.filter((f) => w.t < f.t0 + f.dur);
  }

  private updateCamera(rdt: number) {
    const m = this.map;
    if (!m) return;
    const w = this.world;
    let tx = m.W / 2, ty = this.camY;
    let slowWant = 1, zoomWant = 1;
    const target = this.nextTarget();
    if (this.follow) {
      if (!w || this.phase === "countdown") ty = this.previewCamY();
      else if (target !== null) {
        const { viewH } = this.view();
        ty = w.y[target] + viewH * 0.1;
        tx = w.x[target];
      } else if (this.phase === "done" && this.winners.length) ty = m.goalY + this.view().viewH * 0.08;
    }
    if (w && this.phase === "racing" && this.opts!.slowmo && target !== null) {
      const mode = this.opts!.rule.mode;
      let decider = target;
      if (mode === "last") {
        const k = this.targets.length;
        decider = this.orderN > k ? this.order[this.orderN - k - 1] : -1;
        if (this.orderN > k + 2) decider = -1;
      }
      if (decider >= 0) {
        const d = m.goalY - w.y[decider];
        if (d < 340 && d > -20) {
          slowWant = 0.3;
          zoomWant = 1.45;
          if (this.follow && mode === "last") { ty = w.y[decider]; tx = w.x[decider]; }
        }
      }
    }
    const k = 1 - Math.exp(-rdt * 2.4);
    this.slow += (slowWant - this.slow) * (slowWant < this.slow ? 1 - Math.exp(-rdt * 6) : k);
    this.zoom += (zoomWant - this.zoom) * k;
    if (w) this.sound.intensity = Math.max(0, Math.min(1, 1 - (m.goalY - (target !== null ? w.y[target] : m.goalY)) / 2500));
    const { viewW, viewH } = this.view();
    if (this.follow) {
      const kf = 1 - Math.exp(-rdt * 4.5);
      this.camY += (ty - this.camY) * kf;
      this.camX += (tx - this.camX) * kf;
    }
    this.camY = Math.max(viewH / 2 - 400, Math.min(m.H - viewH / 2 + 40, this.camY));
    if (viewW >= m.W + 40) this.camX = m.W / 2;
    else this.camX = Math.max(viewW / 2 - 20, Math.min(m.W - viewW / 2 + 20, this.camX));
    this.shake *= Math.exp(-rdt * 7);
    this.flash *= Math.exp(-rdt * 3);
    if (this.shake < 0.05) this.shake = 0;
  }

  // ---------- drawing ----------
  private drawStars() {
    const g = this.ctx, cw = this.cw, ch = this.ch;
    for (let l = 0; l < 3; l++) {
      const z = STAR_Z[l] * 0.5;
      g.fillStyle = STAR_STYLE[l];
      g.beginPath();
      for (const st of this.stars[l]) {
        const yy = ((st.y * ch - this.camY * z) % ch + ch) % ch;
        g.rect(st.x * cw, yy, st.s, st.s);
      }
      g.fill();
    }
  }

  private draw() {
    const g = this.ctx, dpr = this.dpr, cw = this.cw, ch = this.ch;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.fillStyle = BG;
    g.fillRect(0, 0, cw, ch);
    this.drawStars();
    const m = this.map;
    if (!m) {
      g.fillStyle = "rgba(238,240,245,0.5)";
      g.font = `500 15px ${FONT}`;
      g.textAlign = "center";
      g.fillText("참가자를 입력하면 구슬이 준비돼요", cw / 2, ch / 2);
      return;
    }
    const { s, viewH, usable } = this.view();
    const shx = this.shake ? (Math.random() - 0.5) * this.shake : 0, shy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const ox = usable / 2 - this.camX * s + shx, oy = ch / 2 - this.camY * s + shy;
    const A = dpr * s, E = dpr * ox, F = dpr * oy;
    g.setTransform(A, 0, 0, A, E, F);
    const top = this.camY - viewH / 2 - 60, bot = this.camY + viewH / 2 + 60;
    const w = this.world;
    const simT = w ? w.t : 0;
    const TAU = Math.PI * 2;

    // section bands and names
    g.font = `600 46px ${FONT}`;
    g.textAlign = "right";
    m.sections.forEach((sec, k) => {
      if (sec.y1 < top || sec.y0 > bot) return;
      const st = this.secStyle[k];
      g.fillStyle = st.band;
      g.fillRect(0, sec.y0, m.W, sec.y1 - sec.y0);
      g.fillStyle = st.name;
      g.fillText(sec.name, m.W - 24, sec.y0 + 56);
    });
    // board rim
    g.strokeStyle = "rgba(238,240,245,0.12)";
    g.lineWidth = 2;
    g.strokeRect(-2, top, m.W + 4, bot - top);

    g.lineCap = "round";
    const T = this.tint;
    // rails: all resting ones in one stroke per width, a hit one brightens on its own
    {
      let open = false;
      g.strokeStyle = this.style(T, 14, 62);
      for (let j = 0; j < m.segs.length; j++) {
        const sg = m.segs[j];
        if (Math.max(sg.y1, sg.y2) < top || Math.min(sg.y1, sg.y2) > bot) continue;
        const lw = sg.t * 2;
        if (!open || g.lineWidth !== lw) { if (open) g.stroke(); g.lineWidth = lw; g.beginPath(); open = true; }
        g.moveTo(sg.x1, sg.y1); g.lineTo(sg.x2, sg.y2);
      }
      if (open) g.stroke();
    }
    if (w) {
      for (let j = 0; j < m.segs.length; j++) {
        const lit = 1 - (simT - w.segHit[j]) * 4;
        if (lit <= 0) continue;
        const sg = m.segs[j];
        if (Math.max(sg.y1, sg.y2) < top || Math.min(sg.y1, sg.y2) > bot) continue;
        g.strokeStyle = this.style(T, 20, 90, lit);
        g.lineWidth = sg.t * 2;
        g.beginPath(); g.moveTo(sg.x1, sg.y1); g.lineTo(sg.x2, sg.y2); g.stroke();
      }
    }
    // gate
    if (!w || !w.gateOpen) {
      const gy = m.gateY;
      g.fillStyle = "rgba(242,193,78,0.12)";
      g.fillRect(0, gy - 16, m.W, 26);
      g.strokeStyle = ACCENT;
      g.lineWidth = 8;
      g.beginPath(); g.moveTo(0, gy); g.lineTo(m.W, gy); g.stroke();
      g.fillStyle = "rgba(30,20,4,0.85)";
      g.beginPath();
      for (let x = -40; x < m.W; x += 40) {
        g.moveTo(x, gy - 4); g.lineTo(x + 18, gy - 4); g.lineTo(x + 26, gy + 4); g.lineTo(x + 8, gy + 4); g.closePath();
      }
      g.fill();
    } else if (simT - GATE_T < 0.6) {
      const e = (simT - GATE_T) / 0.6, gy = m.gateY;
      g.globalAlpha = 1 - e;
      g.strokeStyle = ACCENT;
      g.lineWidth = 8;
      g.beginPath(); g.moveTo(0, gy); g.lineTo(m.W / 2 * (1 - e), gy); g.moveTo(m.W, gy); g.lineTo(m.W - m.W / 2 * (1 - e), gy); g.stroke();
      g.globalAlpha = 1;
    }

    // pins: one path; a pin that was just hit flares
    g.fillStyle = this.style(T, 14, 72);
    g.beginPath();
    for (let p = 0; p < m.pegs.length; p++) {
      const pg = m.pegs[p];
      if (pg.kick || pg.y < top || pg.y > bot) continue;
      g.moveTo(pg.x + pg.r, pg.y);
      g.arc(pg.x, pg.y, pg.r, 0, TAU);
    }
    g.fill();
    if (w) {
      g.globalCompositeOperation = "lighter";
      for (let p = 0; p < m.pegs.length; p++) {
        const pg = m.pegs[p];
        if (pg.y < top || pg.y > bot) continue;
        const lit = 1 - (simT - w.pegHit[p]) * (pg.kick ? 3 : 5);
        if (lit <= 0) continue;
        const gs = pg.r * (pg.kick ? 3 : 4.5) * (1 + lit * 0.5);
        g.globalAlpha = lit;
        g.drawImage(this.glow(T), pg.x - gs, pg.y - gs, gs * 2, gs * 2);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
    }
    for (let p = 0; p < m.pegs.length; p++) {
      const pg = m.pegs[p];
      if (!pg.kick || pg.y < top || pg.y > bot) continue;
      const lit = w ? Math.max(0, 1 - (simT - w.pegHit[p]) * 3) : 0;
      const r = pg.r * (1 + lit * 0.18);
      g.drawImage(this.bumper(T), pg.x - r, pg.y - r, r * 2, r * 2);
      g.strokeStyle = this.style(T, 16, 78, 0.35 + Math.round(lit * 5) / 10);
      g.lineWidth = 3;
      g.beginPath(); g.arc(pg.x, pg.y, r + 5 + lit * 6, 0, TAU); g.stroke();
    }
    // rotors
    for (let r = 0; r < m.rotors.length; r++) {
      const ro = m.rotors[r];
      if (ro.cy + ro.len < top || ro.cy - ro.len > bot) continue;
      const ang = w ? w.rAng[r] : ro.a;
      const lit = w ? Math.max(0, 1 - (simT - w.rotorHit[r]) * 4) : 0;
      const c = Math.cos(ang), sn = Math.sin(ang), a = ro.arms;
      g.strokeStyle = this.style(T, 14, 62, 0.08);
      g.lineWidth = 2;
      g.beginPath(); g.arc(ro.cx, ro.cy, ro.len, 0, TAU); g.stroke();
      g.beginPath();
      for (let k = 0; k < a.length; k += 4) {
        g.moveTo(ro.cx + a[k] * c - a[k + 1] * sn, ro.cy + a[k] * sn + a[k + 1] * c);
        g.lineTo(ro.cx + a[k + 2] * c - a[k + 3] * sn, ro.cy + a[k + 2] * sn + a[k + 3] * c);
      }
      g.strokeStyle = this.style(T, 16, 66 + Math.round(lit * 4) * 6);
      g.lineWidth = ro.t * 2;
      g.stroke();
      g.fillStyle = this.style(T, 14, 84);
      g.beginPath(); g.arc(ro.cx, ro.cy, 12, 0, TAU); g.fill();
      g.fillStyle = this.style(T, 14, 20);
      g.beginPath(); g.arc(ro.cx, ro.cy, 5, 0, TAU); g.fill();
    }
    // finish line
    if (m.goalY > top && m.goalY < bot + 200) {
      const gy = m.goalY, sq = 20;
      for (let pass = 0; pass < 2; pass++) {
        g.fillStyle = pass ? "rgba(238,240,245,0.85)" : "rgba(14,16,24,0.9)";
        g.beginPath();
        for (let x = 0, k = 0; x < m.W; x += sq, k++) {
          g.rect(x, (k + pass) % 2 ? gy - sq : gy, sq, sq);
        }
        g.fill();
      }
      g.fillStyle = "rgba(242,193,78,0.85)";
      g.font = `600 36px ${FONT}`;
      g.textAlign = "center";
      g.fillText("결승", m.W / 2, gy + 76);
    }
    // effects from the simulation
    if (w) for (const f of w.effects) {
      const age = simT - f.t0;
      if (age < 0 || age > f.dur) continue;
      const e = age / f.dur;
      if (f.k === "shock") {
        g.globalAlpha = 1 - e;
        g.strokeStyle = "rgb(130,220,245)";
        g.lineWidth = 10 * (1 - e) + 2;
        g.beginPath(); g.arc(f.x, f.y, f.r * (0.2 + e * 0.9), 0, TAU); g.stroke();
        g.globalAlpha = 1;
      } else if (f.k === "wind") {
        g.globalAlpha = 0.35 * Math.sin(e * Math.PI);
        g.strokeStyle = "rgb(170,240,215)";
        g.lineWidth = 3;
        g.beginPath();
        for (let k = 0; k < 14; k++) {
          const yy = f.y - f.r + ((k * 97) % (f.r * 2));
          const xx = ((k * 211 + age * 900 * f.dir) % 1200 + 1200) % 1200 - 100;
          g.moveTo(xx, yy); g.lineTo(xx - f.dir * 120, yy);
        }
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    // balls
    const n = this.slotOf.length;
    const R = this.R;
    const roster = this.opts!.roster;
    const target = this.nextTarget();
    const tagged = new Set<number>();
    if (w && this.phase !== "countdown") {
      for (let k = 0; k < Math.min(3, this.orderN); k++) tagged.add(this.order[k]);
      if (target !== null) tagged.add(target);
    }
    for (const b of this.winners) tagged.add(b.ball);
    // trails behind the tagged balls
    if (w) {
      for (const b of tagged) {
        let tr = this.trails.get(b);
        if (!tr) { tr = []; this.trails.set(b, tr); }
        if (!w.done[b]) { tr.push(w.x[b], w.y[b]); if (tr.length > 44) tr.splice(0, 2); }
      }
      for (const [b, tr] of this.trails) {
        if (!tagged.has(b)) { this.trails.delete(b); continue; }
        if (tr.length < 4) continue;
        g.strokeStyle = this.style(Math.round(paletteColor(roster.colorIdx[b]).hue), 90, 70);
        for (let k = 2; k < tr.length; k += 2) {
          const a = k / tr.length;
          g.globalAlpha = a * 0.4;
          g.lineWidth = R * 1.6 * a;
          g.beginPath(); g.moveTo(tr[k - 2], tr[k - 1]); g.lineTo(tr[k], tr[k + 1]); g.stroke();
        }
      }
      g.globalAlpha = 1;
    }
    const ease = this.shuffleEase();
    const atlas = R * s >= 8.5 ? this.atlas : null;
    const cell = this.atlasCell, cols = this.atlasCols, slot = this.atlasSlot;
    const D = R * 2;
    for (let i = 0; i < n; i++) {
      let bx: number, by: number;
      if (w) {
        if (w.done[i]) continue;
        bx = w.x[i]; by = w.y[i];
      } else [bx, by] = this.previewPos(i, ease);
      if (by < top - R || by > bot + R) continue;
      if (w && w.boostUntil[i] > simT) {
        g.globalCompositeOperation = "lighter";
        const gs = R * 4;
        g.drawImage(this.glow(30), bx - gs, by - gs, gs * 2, gs * 2);
        g.globalCompositeOperation = "source-over";
      }
      if (atlas) {
        const k = slot[i];
        g.drawImage(atlas, (k % cols) * cell, Math.floor(k / cols) * cell, cell, cell, bx - R, by - R, D, D);
      } else g.drawImage(this.sprites[roster.colorIdx[i]], bx - R, by - R, D, D);
    }
    // name tags for the leaders and the ball the camera is following
    if (w && this.phase !== "countdown") {
      const fs = Math.max(13, 15 / s);
      g.font = `600 ${fs}px ${FONT}`;
      g.textAlign = "center";
      const placed: number[] = [];
      const ordered = [...tagged].sort((a, b) => (a === target ? -1 : b === target ? 1 : 0));
      for (const b of ordered) {
        if (w.done[b]) continue;
        const bx = w.x[b], by = w.y[b];
        if (by < top || by > bot) continue;
        const label = `${this.liveRank(b)}위 ${this.nameOf(b)}`;
        const tw = g.measureText(label).width + fs;
        const isT = b === target;
        const yy = by - R - fs * 1.5;
        let clash = false;
        for (let k = 0; k < placed.length; k += 3) {
          if (Math.abs(placed[k] - bx) < (placed[k + 2] + tw) / 2 && Math.abs(placed[k + 1] - yy) < fs * 1.5) clash = true;
        }
        if (clash) continue;
        placed.push(bx, yy, tw);
        g.fillStyle = isT ? ACCENT : "rgba(12,14,22,0.88)";
        roundRect(g, bx - tw / 2, yy - fs * 0.85, tw, fs * 1.4, fs * 0.35);
        g.fill();
        g.fillStyle = isT ? "#1c1503" : "#eef0f5";
        g.fillText(label, bx, yy + fs * 0.2);
        if (isT) {
          g.strokeStyle = ACCENT;
          g.lineWidth = 3 / s;
          g.beginPath(); g.arc(bx, by, R + 6, 0, TAU); g.stroke();
        }
      }
    }
    // sparks, sorted into color buckets so each bucket is one stroke
    if (this.pn) {
      const cnt = this.sparkCount, ord = this.sparkOrder;
      cnt.fill(0);
      const keyOf = (i: number) => {
        const hb = Math.floor((((this.phue[i] % 360) + 360) % 360) / (360 / SPARK_HUES)) % SPARK_HUES;
        const ab = Math.min(SPARK_ALPHAS - 1, Math.floor((this.plife[i] / this.pmax[i]) * SPARK_ALPHAS));
        return hb * SPARK_ALPHAS + ab;
      };
      for (let i = 0; i < this.pn; i++) if (this.pkind[i] !== 1) cnt[keyOf(i) + 1]++;
      for (let k = 0; k < SPARK_KEYS; k++) cnt[k + 1] += cnt[k];
      const end = cnt[SPARK_KEYS];
      const pos = cnt.slice(0, SPARK_KEYS);
      for (let i = 0; i < this.pn; i++) if (this.pkind[i] !== 1) ord[pos[keyOf(i)]++] = i;
      g.globalCompositeOperation = "lighter";
      for (let k = 0, q = 0; k < SPARK_KEYS && q < end; k++) {
        const stop = cnt[k + 1];
        if (q === stop) continue;
        g.strokeStyle = SPARK_STYLE[k];
        g.lineWidth = 3 * (((k % SPARK_ALPHAS) + 0.5) / SPARK_ALPHAS) + 1;
        g.beginPath();
        for (; q < stop; q++) {
          const i = ord[q];
          g.moveTo(this.px[i], this.py[i]);
          g.lineTo(this.px[i] - this.pvx[i] * 0.03, this.py[i] - this.pvy[i] * 0.03);
        }
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
      // confetti: one transform per piece, no save/restore
      for (let i = 0; i < this.pn; i++) {
        if (this.pkind[i] !== 1) continue;
        const rot = this.prot[i], c = Math.cos(rot), sn = Math.sin(rot), k = Math.cos(rot * 1.7);
        g.setTransform(A * c, A * sn, -A * sn * k, A * c * k, E + A * this.px[i], F + A * this.py[i]);
        g.globalAlpha = Math.min(1, (this.plife[i] / this.pmax[i]) * 2);
        g.fillStyle = CONFETTI_STYLE[Math.floor((((this.phue[i] % 360) + 360) % 360) / 30) % 12];
        g.fillRect(-7, -4, 14, 8);
      }
      g.globalAlpha = 1;
      g.setTransform(A, 0, 0, A, E, F);
    }
    // floating callouts
    if (this.pops.length) {
      g.textAlign = "center";
      g.lineJoin = "round";
      this.pops = this.pops.filter((p) => this.time - p.t < 1.6);
      const fs = Math.max(20, 22 / s);
      g.font = `600 ${fs}px ${FONT}`;
      g.lineWidth = fs * 0.22;
      for (const p of this.pops) {
        const age = this.time - p.t;
        g.globalAlpha = Math.min(1, (1.6 - age) * 2);
        g.strokeStyle = "rgba(0,0,0,0.6)";
        g.fillStyle = p.hue === 50 ? ACCENT : "#eef0f5";
        g.strokeText(p.text, p.x, p.y - age * 50);
        g.fillText(p.text, p.x, p.y - age * 50);
      }
      g.globalAlpha = 1;
    }

    // screen space: flash, vignette, minimap
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.flash > 0.01) {
      g.globalAlpha = this.flash * 0.4;
      g.fillStyle = "rgb(255,240,205)";
      g.fillRect(0, 0, cw, ch);
      g.globalAlpha = 1;
    }
    if (this.slow < 0.9) {
      if (!this.vignette) {
        const v = g.createRadialGradient(usable / 2, ch / 2, Math.min(usable, ch) * 0.3, usable / 2, ch / 2, Math.max(usable, ch) * 0.75);
        v.addColorStop(0, "rgba(0,0,0,0)");
        v.addColorStop(1, "rgba(30,4,10,0.7)");
        this.vignette = v;
      }
      g.globalAlpha = Math.min(1, 1 - this.slow);
      g.fillStyle = this.vignette;
      g.fillRect(0, 0, cw, ch);
      g.globalAlpha = 1;
    }
    this.drawMinimap(viewH);
  }

  private liveRank(b: number) {
    const w = this.world!;
    const ft = w.finishOrder.length;
    for (let k = 0; k < this.orderN; k++) if (this.order[k] === b) return ft + k + 1;
    return w.finishOrder.indexOf(b) + 1;
  }

  private miniRect() {
    const x = this.cw - MINIMAP_W - 6, y = 14, h = this.ch - 28;
    return { x, y, w: MINIMAP_W, h };
  }

  private drawMinimap(viewH: number) {
    const m = this.map!;
    const g = this.ctx;
    const r = this.miniRect();
    const sy = r.h / (m.H + 400), sx = r.w / m.W;
    const Y = (y: number) => r.y + (y + 400) * sy;
    g.fillStyle = "rgba(7,8,13,0.82)";
    roundRect(g, r.x - 4, r.y - 4, r.w + 8, r.h + 8, 8);
    g.fill();
    m.sections.forEach((sec, k) => {
      g.fillStyle = this.secStyle[k].mini;
      g.fillRect(r.x, Y(sec.y0), r.w, Math.max(1, (sec.y1 - sec.y0) * sy - 1));
    });
    g.fillStyle = ACCENT;
    g.fillRect(r.x, Y(m.goalY) - 1, r.w, 2);
    const w = this.world;
    const sz = this.slotOf.length > 400 ? 1.5 : 2.5, hs = sz / 2;
    // one path per color: 48 fills instead of a style change per ball
    for (let c = 0; c < this.byColor.length; c++) {
      const list = this.byColor[c];
      if (!list.length) continue;
      g.beginPath();
      for (let q = 0; q < list.length; q++) {
        const i = list[q];
        let bx: number, by: number;
        if (w) { if (w.done[i]) continue; bx = w.x[i]; by = w.y[i]; }
        else { const sl = this.slotOf[i] * 2; bx = m.slots[sl]; by = m.slots[sl + 1]; }
        g.rect(r.x + bx * sx - hs, Y(by) - hs, sz, sz);
      }
      g.fillStyle = paletteColor(c).css;
      g.fill();
    }
    const t = this.nextTarget();
    if (w && t !== null) {
      g.strokeStyle = ACCENT;
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(r.x + w.x[t] * sx, Y(w.y[t]), 4, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = "rgba(238,240,245,0.6)";
    g.lineWidth = 1;
    g.strokeRect(r.x - 1, Y(this.camY - viewH / 2), r.w + 2, viewH * sy);
  }

  // ---------- HUD ----------
  private emitHud(force: boolean) {
    this.hudT = 0.15;
    const w = this.world;
    const n = this.slotOf.length;
    const leaders: Leader[] = [];
    if (w && this.phase !== "countdown") {
      const fo = w.finishOrder;
      const fromFinished = Math.min(fo.length, 3);
      for (let k = 0; k < fromFinished; k++) leaders.push(this.leader(fo[k], k + 1, true));
      for (let k = 0; k < this.orderN && leaders.length < 8; k++) leaders.push(this.leader(this.order[k], fo.length + k + 1, false));
    }
    const t = this.nextTarget();
    const finished = w?.finishOrder.length ?? 0;
    if (!force && finished === this.lastCount && this.phase !== "racing" && this.phase !== "countdown") return;
    this.lastCount = finished;
    this.cb.onHud({
      phase: this.phase,
      countdown: w && this.phase === "countdown" ? Math.ceil(GATE_T - w.t) : 0,
      elapsed: w ? Math.max(0, w.t - GATE_T) : 0,
      finished,
      total: n,
      leaders,
      follow: this.follow,
      paused: this.paused,
      speed: this.speed,
      slow: this.slow < 0.8,
      target: t !== null ? this.nameOf(t) : null,
    });
  }
  private leader(b: number, rank: number, done: boolean): Leader {
    return { ball: b, name: this.nameOf(b), color: this.colorOf(b), rank, done };
  }

  // ---------- pointer ----------
  private onDown = (e: PointerEvent) => {
    if (!this.map) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const mr = this.miniRect();
    const mini = x >= mr.x - 6;
    this.drag = { x: e.clientX, y: e.clientY, cx: this.camX, cy: this.camY, mini };
    if (mini) this.jumpMini(y);
  };
  private onMove = (e: PointerEvent) => {
    if (!this.drag || !this.map) return;
    const rect = this.canvas.getBoundingClientRect();
    if (this.drag.mini) return this.jumpMini(e.clientY - rect.top);
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 4 && this.follow) return;
    const { s } = this.view();
    this.camX = this.drag.cx - dx / s;
    this.camY = this.drag.cy - dy / s;
    this.unfollow();
  };
  private onUp = () => { this.drag = null; };
  private onWheel = (e: WheelEvent) => {
    if (!this.map) return;
    e.preventDefault();
    const { s } = this.view();
    this.camY += e.deltaY / s * 0.8;
    this.unfollow();
  };
  private jumpMini(y: number) {
    const m = this.map!;
    const r = this.miniRect();
    this.camY = (y - r.y) / (r.h / (m.H + 400)) - 400;
    this.unfollow();
  }
  private unfollow() {
    if (this.follow) {
      this.follow = false;
      this.emitHud(true);
    }
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
