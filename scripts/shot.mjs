// Headless check of the marble draw: node scripts/draw-shot.mjs [url] [outDir] [count]
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5180/";
const out = process.argv[3] ?? "/tmp/draw-shots";
const count = +(process.argv[4] ?? 1000);
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1200);
await shot("0-sample");
await page.getByRole("textbox", { name: "참가자" }).fill(`1~${count}`);
await page.waitForTimeout(900);
await shot("1-preview");
await page.getByRole("button", { name: "섞기" }).click();
await page.waitForTimeout(500);
await shot("2-shuffling");
await page.waitForTimeout(900);
await page.getByRole("button", { name: "시작", exact: true }).click();
await page.waitForTimeout(1500);
await shot("3-countdown");
await page.waitForTimeout(3000);
await shot("4-gate-open");
const t0 = Date.now();
const samples = [];
for (let k = 0; k < 12; k++) {
  await page.waitForTimeout(2500);
  const s = await page.evaluate(() => { const e = window.__draw; return { t: e.world?.t, fin: e.world?.finishOrder.length, phase: e.phase, winners: e.winners.length }; });
  samples.push(s);
  if (k === 2 || k === 5) await shot(`5-race-${k}`);
  if (s.phase === "done") break;
}
await shot("6-finish");
await page.waitForTimeout(2600);
await shot("7-result");
const fps = await page.evaluate(() => new Promise((res) => { let f = 0; const t = performance.now(); const tick = () => { f++; if (performance.now() - t < 2000) requestAnimationFrame(tick); else res(f / 2); }; requestAnimationFrame(tick); }));
console.log(JSON.stringify({ samples, fps, wall: Date.now() - t0, errors }, null, 1));
await browser.close();
