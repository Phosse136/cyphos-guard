import { chromium } from "playwright-core";

const [url, out, scheme, w] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const p = await b.newPage({ viewport: { width: Number(w), height: 900 }, colorScheme: scheme });
await p.goto(url, { waitUntil: "networkidle" });
await p.screenshot({ path: out, fullPage: true });
await b.close();
