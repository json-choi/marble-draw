export const MAX_BALLS = 1000;
export const PALETTE_SIZE = 48;

export type Roster = {
  names: string[]; // one per ball
  colorIdx: Uint16Array; // palette slot per ball (same name, same color)
  distinct: number;
  requested: number; // before the cap
};

// One entry per line or comma. "이름*3" makes 3 balls, "1~100" makes numbered balls.
export function parseRoster(text: string): Roster {
  const names: string[] = [];
  let requested = 0;
  const push = (name: string, times: number) => {
    requested += times;
    for (let k = 0; k < times && names.length < MAX_BALLS; k++) names.push(name);
  };
  for (const raw of text.split(/[\n,]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const range = tok.match(/^(\d{1,6})\s*[~～\-–]\s*(\d{1,6})$/);
    if (range) {
      let a = parseInt(range[1], 10);
      let b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      requested += b - a + 1;
      for (let v = a; v <= b && names.length < MAX_BALLS; v++) names.push(String(v));
      continue;
    }
    const rep = tok.match(/^(.+?)\s*[*×]\s*(\d{1,4})$/);
    if (rep) {
      const name = rep[1].trim();
      if (name) push(name, Math.max(0, parseInt(rep[2], 10)));
      continue;
    }
    push(tok, 1);
  }
  const order = new Map<string, number>();
  const colorIdx = new Uint16Array(names.length);
  names.forEach((n, i) => {
    let k = order.get(n);
    if (k === undefined) {
      k = order.size;
      order.set(n, k);
    }
    colorIdx[i] = k % PALETTE_SIZE;
  });
  return { names, colorIdx, distinct: order.size, requested };
}

// Spread hues with the golden angle so neighbours in the list never look alike.
// Computed once: the minimap and the HUD ask for these colors every frame.
const PALETTE = Array.from({ length: PALETTE_SIZE }, (_, k) => {
  const hue = (k * 137.508 + 8) % 360;
  const light = k % 3 === 0 ? 62 : k % 3 === 1 ? 55 : 68;
  return { hue, css: `hsl(${hue.toFixed(1)} 88% ${light}%)` };
});

export function paletteColor(k: number): { hue: number; css: string } {
  return PALETTE[k % PALETTE_SIZE];
}

export function shortLabel(name: string): string {
  if (/^\d+$/.test(name)) return name.length > 4 ? name.slice(-4) : name;
  const chars = Array.from(name);
  return chars.length > 3 ? chars.slice(0, 2).join("") : chars.join("");
}
