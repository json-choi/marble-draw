// Every sound is synthesized: no audio files to license or download.
export class Sound {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  recordDest: MediaStreamAudioDestinationNode | null = null;
  sfxOn = true;
  musicOn = true;
  private noise!: AudioBuffer;
  private seqTimer = 0;
  private nextNote = 0;
  private step16 = 0;
  intensity = 0; // 0..1, raised near the finish
  private lastTick = 0;
  private ticksThisFrame = 0;

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxOn ? 1 : 0;
    this.music = ctx.createGain();
    this.music.gain.value = this.musicOn ? 0.42 : 0;
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    this.master.connect(comp);
    comp.connect(ctx.destination);
    try {
      this.recordDest = ctx.createMediaStreamDestination();
      comp.connect(this.recordDest);
    } catch {
      this.recordDest = null;
    }
    const len = ctx.sampleRate * 1;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setSfx(on: boolean) {
    this.sfxOn = on;
    if (this.ctx) this.sfx.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
  }
  setMusic(on: boolean) {
    this.musicOn = on;
    if (this.ctx) this.music.gain.setTargetAtTime(on ? 0.42 : 0, this.ctx.currentTime, 0.1);
  }

  frame() {
    this.ticksThisFrame = 0;
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType, at = 0, slideTo = 0, dest?: AudioNode) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest ?? this.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, vol: number, freq: number, q: number, at = 0, dest?: AudioNode, type: BiquadFilterType = "bandpass") {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(dest ?? this.sfx);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  // pan-free little glass tick; pitch follows the board position
  tick(pos: number, strength: number) {
    if (!this.ctx || !this.sfxOn || this.ticksThisFrame >= 3) return;
    const now = this.ctx.currentTime;
    if (now - this.lastTick < 0.018) return;
    this.lastTick = now;
    this.ticksThisFrame++;
    const notes = [1318, 1568, 1760, 2093, 2349, 2637];
    const f = notes[Math.floor(pos * notes.length) % notes.length];
    this.tone(f, 0.09, Math.min(0.09, 0.025 + strength / 9000), "triangle");
  }
  boing(strength: number) {
    if (!this.ctx || !this.sfxOn) return;
    this.tone(220 + Math.random() * 60, 0.22, Math.min(0.28, 0.1 + strength / 4000), "sine", 0, 640);
    this.tone(880, 0.06, 0.06, "square");
  }
  thud() {
    if (!this.ctx || !this.sfxOn) return;
    this.tone(150, 0.12, 0.08, "sine", 0, 70);
  }
  chime(rankish: number) {
    if (!this.ctx || !this.sfxOn) return;
    const base = 784 * Math.pow(2, (rankish % 5) / 12);
    this.tone(base, 0.25, 0.08, "sine");
    this.tone(base * 2, 0.18, 0.03, "sine", 0.02);
  }
  beep(final: boolean) {
    if (!this.ctx) return;
    this.tone(final ? 1046 : 523, final ? 0.5 : 0.18, 0.22, "square");
    if (final) this.burst(0.8, 0.35, 900, 0.6, 0, undefined, "highpass");
  }
  whoosh() {
    if (!this.ctx) return;
    this.burst(0.5, 0.25, 600, 0.8);
  }
  dash() {
    if (!this.ctx || !this.sfxOn) return;
    this.tone(300, 0.35, 0.12, "sawtooth", 0, 1400);
  }
  shock() {
    if (!this.ctx || !this.sfxOn) return;
    this.tone(110, 0.45, 0.3, "sine", 0, 40);
    this.burst(0.4, 0.2, 300, 1);
  }
  gust() {
    if (!this.ctx || !this.sfxOn) return;
    this.burst(1.4, 0.18, 500, 0.4);
  }
  fanfare() {
    if (!this.ctx) return;
    const seq = [523, 659, 784, 1046, 1318];
    seq.forEach((f, k) => {
      this.tone(f, 0.35, 0.18, "square", k * 0.09);
      this.tone(f / 2, 0.35, 0.1, "triangle", k * 0.09);
    });
    [1046, 1318, 1568].forEach((f) => this.tone(f, 1.6, 0.12, "sawtooth", 0.5));
    this.burst(1.2, 0.3, 6000, 0.5, 0.45, undefined, "highpass");
  }

  // a driving 125 bpm loop: kick, hats, a minor arpeggio
  startMusic() {
    if (!this.ctx || this.seqTimer) return;
    this.nextNote = this.ctx.currentTime + 0.05;
    this.step16 = 0;
    this.seqTimer = window.setInterval(() => this.schedule(), 25);
  }
  stopMusic() {
    if (this.seqTimer) clearInterval(this.seqTimer);
    this.seqTimer = 0;
  }
  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const spb = 60 / 125 / 4;
    const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]];
    while (this.nextNote < ctx.currentTime + 0.12) {
      const s = this.step16;
      const at = this.nextNote - ctx.currentTime;
      const bar = Math.floor(s / 16) % 4;
      const ch = chords[bar];
      if (s % 4 === 0) this.tone(120, 0.18, 0.5, "sine", at, 45, this.music);
      if (s % 2 === 1 || this.intensity > 0.5) this.burst(0.04, 0.05 + this.intensity * 0.06, 8000, 0.7, at, this.music, "highpass");
      if (s % 8 === 4) this.burst(0.12, 0.12, 1800, 0.8, at, this.music);
      const note = ch[s % 3] * (s % 6 < 3 ? 2 : 1);
      this.tone(note, 0.11, 0.06 + this.intensity * 0.04, "sawtooth", at, 0, this.music);
      if (s % 16 === 0) this.tone(ch[0] / 2, spb * 15, 0.12, "triangle", at, 0, this.music);
      this.nextNote += spb;
      this.step16++;
    }
  }
}
