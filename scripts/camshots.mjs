// スキー場ライブカメラのページを撮影して out/ に保存する（Node 20, ESM, 依存: playwright）
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

// top/height は切り出し範囲（CSSピクセル）。後で調整する。wait は読み込み後の待機(ms)。
const TARGETS = [
  { id: "happo", url: "https://www.happo-one.jp/gelande/livecamera/", top: 0, height: 1600, wait: 8000 },
  { id: "tangram", url: "https://www.tangram.jp/ski/livecamera/", top: 0, height: 1600, wait: 8000 },
  { id: "parada", url: "https://www.saku-parada.jp/ski/livecam/", top: 0, height: 1600, wait: 8000 },
  { id: "shiga-yake", url: "https://www.princehotels.co.jp/ski/shiga/informations/weather_camera/", top: 0, height: 1600, wait: 8000 },
  { id: "annupuri", url: "https://camstreamer.com/live/stream/749662862", top: 0, height: 1600, wait: 8000 },
  { id: "rusutsu", url: "https://rusutsu.com/en/live-mountain-cams/", top: 0, height: 1600, wait: 8000 },
  { id: "kokusai", url: "https://www.sapporo-kokusai.jp/live.php", top: 0, height: 1600, wait: 8000 },
];

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const OUT = "out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 1600 },
  deviceScaleFactor: 1.5,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  userAgent: UA,
});

const shots = {};
for (const t of TARGETS) {
  const page = await context.newPage();
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(t.wait);
    await page
      .evaluate(() => {
        document.querySelectorAll("video").forEach((v) => {
          try {
            v.muted = true;
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          } catch {}
        });
      })
      .catch(() => {});
    await sleep(2000);
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const height = Math.floor(Math.min(t.height, scrollHeight - t.top));
    if (!(height >= 1)) throw new Error(`clip height invalid (scrollHeight=${scrollHeight}, top=${t.top})`);
    await page.screenshot({
      path: `${OUT}/${t.id}.jpg`,
      type: "jpeg",
      quality: 72,
      clip: { x: 0, y: t.top, width: 390, height },
      fullPage: true,
    });
    shots[t.id] = { ok: true, at: now(), url: t.url };
    console.log(`OK   ${t.id}`);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).split("\n")[0].slice(0, 200);
    shots[t.id] = { ok: false, at: now(), url: t.url, error: msg };
    console.log(`FAIL ${t.id}: ${msg}`);
  } finally {
    await page.close().catch(() => {});
  }
}

await browser.close();
await writeFile(`${OUT}/index.json`, JSON.stringify({ generatedAt: now(), shots }, null, 2) + "\n", "utf8");
if (Object.values(shots).every((s) => !s.ok)) process.exit(1);
