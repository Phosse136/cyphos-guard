/**
 * Renders e2e/promo/scene.html frame by frame (deterministic: window.render(t)) and encodes it with ffmpeg:
 *   cyphos-guard-demo.gif   for X / README (palette-optimised)
 *   cyphos-guard-demo.mp4   for X (H.264, better quality per byte)
 *   cyphos-guard-demo.webm  + poster.png for the landing page
 *
 *   node e2e/promo/promo-video.ts [outDir]      (needs Chromium + ffmpeg)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const out = resolve(process.argv[2] ?? join(import.meta.dirname, "out"));
const FPS = 20;
mkdirSync(out, { recursive: true });
const frames = mkdtempSync(join(tmpdir(), "cg-frames-"));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 676 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(import.meta.dirname, "scene.html")).href);
const duration = await page.evaluate(() => (window as unknown as { DURATION: number }).DURATION);
const n = Math.round(duration * FPS);
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => (window as unknown as { render: (t: number) => void }).render(t), i / FPS);
  await page.screenshot({ path: join(frames, `f${String(i).padStart(4, "0")}.png`) });
}
// poster: the moment the approval card is on screen
await page.evaluate(() => (window as unknown as { render: (t: number) => void }).render(7.2));
await page.screenshot({ path: join(out, "cyphos-guard-demo-poster.png") });
await browser.close();

const input = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "f%04d.png")];
const ff = (...args: string[]) => execFileSync("ffmpeg", [...input, ...args], { stdio: "inherit" });
ff(
  "-vf",
  "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  join(out, "cyphos-guard-demo.gif"),
);
ff(
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "20",
  "-preset",
  "slow",
  "-movflags",
  "+faststart",
  join(out, "cyphos-guard-demo.mp4"),
);
ff(
  "-c:v",
  "libvpx-vp9",
  "-pix_fmt",
  "yuv420p",
  "-b:v",
  "0",
  "-crf",
  "36",
  "-row-mt",
  "1",
  join(out, "cyphos-guard-demo.webm"),
);
rmSync(frames, { recursive: true, force: true });

for (const f of [
  "cyphos-guard-demo.gif",
  "cyphos-guard-demo.mp4",
  "cyphos-guard-demo.webm",
  "cyphos-guard-demo-poster.png",
]) {
  console.log(`${(statSync(join(out, f)).size / 1024).toFixed(0).padStart(6)} KB  ${join(out, f)}`);
}
