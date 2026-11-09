// Seeded RNG: the same seed, participants and map replay the same race in the same browser.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

export const seedText = (s: number) => (s >>> 0).toString(16).toUpperCase().padStart(8, "0");

export function parseSeed(text: string): number | null {
  const t = text.trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(t)) return null;
  return parseInt(t, 16) >>> 0;
}

export function permutation(n: number, rnd: () => number): Int32Array {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}
