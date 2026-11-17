// ユキヨミのライブカメラを定時に撮影して out/ に保存する（Node 20, ESM, 依存: playwright）
// 撮影対象は yukiyomi.html の SITES から読み出す（一覧を二重に持たないため）。
//   c.e = [top, h] … ページを幅360pxで開き、上から top〜top+h の範囲を撮る（アプリの切り出し表示と同じ範囲）
//   c.y = [[YouTubeID, ラベル], …] … YouTube は撮影すると bot 確認画面になるので、配信のサムネイル画像を保存する
//   c.s = "rusutsu" … 個別設定で撮るカメラ（下の SPECIAL）
// 画像名（キー）はアプリ側の shotKey() と同じ規則：e は「スキー場ID-番号」、y は「yt-動画ID」、s はその名前。
import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";

const OUT = "out";
const W = 360; // アプリの切り出し表示と同じ幅
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SPECIAL = {
  rusutsu: { top: 330, height: 390, width: 390, wait: 8000 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const short = (e) => String(e && e.message ? e.message : e).split("\n")[0].slice(0, 200);

// ---- 撮影対象を yukiyomi.html から作る ----
const html = await readFile("yukiyomi.html", "utf8");
const m = html.match(/const SITES = (\{.*?\});\n/s);
if (!m) throw new Error("yukiyomi.html に SITES が見つかりません");
const SITES = JSON.parse(m[1]);
const pages = []; // { key, url, top, height, width, wait }
const tubes = new Set(); // YouTube 動画ID
for (const [rid, st] of Object.entries(SITES)) {
  (st.cams || []).forEach((c, i) => {
    if (c.e) pages.push({ key: `${rid}-${i}`, url: c.u, top: c.e[0], height: c.e[1], width: W, wait: 7000 });
    if (c.s && SPECIAL[c.s]) pages.push({ key: c.s, url: c.u, ...SPECIAL[c.s] });
    (c.y || []).forEach(([id]) => tubes.add(id));
  });
}
console.log(`pages ${pages.length} / youtube ${tubes.size}`);

await mkdir(OUT, { recursive: true });
const shots = {};

// ---- YouTube：配信のサムネイル（ライブ中は数分おきに更新される）を保存 ----
for (const id of tubes) {
  const key = `yt-${id}`;
  let saved = false, err = "";
  for (const name of ["maxresdefault_live", "hqdefault_live", "hqdefault"]) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`, { headers: { "User-Agent": UA } });
      if (!r.ok) { err = `${name} ${r.status}`; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 2000) { err = `${name} too small`; continue; }
      await writeFile(`${OUT}/${key}.jpg`, buf);
      shots[key] = { ok: true, at: now(), src: name };
      saved = true;
      console.log(`OK   ${key} (${name})`);
      break;
    } catch (e) { err = short(e); }
  }
  if (!saved) { shots[key] = { ok: false, at: now(), error: err }; console.log(`FAIL ${key}: ${err}`); }
}

// ---- ページ型：開いて切り出して撮影（4枚ずつ並行） ----
const browser = await chromium.launch({ headless: true });
async function shoot(t) {
  const context = await browser.newContext({
    viewport: { width: t.width, height: Math.max(800, t.top + t.height + 300) },
    deviceScaleFactor: 1.5,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent: UA,
  });
  const page = await context.newPage();
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(t.wait);
    await page.evaluate(() => {
      document.querySelectorAll("video").forEach((v) => {
        try { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch {}
      });
    }).catch(() => {});
    await sleep(2000);
    // ページ内の YouTube・skiday の埋め込みを記録（撮影がうまくいかないカメラを差し替える手がかり）
    const found = new Set();
    const pick = (s) => {
      const y = String(s).match(/(?:youtube(?:-nocookie)?\.com\/(?:embed|live)\/|youtu\.be\/|[?&]v=)([\w-]{11})/);
      if (y) found.add("yt:" + y[1]);
      const k = String(s).match(/skiday\.app\/[\w]+\/\d+\/embed/);
      if (k) found.add("https://" + k[0]);
    };
    page.frames().forEach((f) => pick(f.url()));
    const attrs = await page.evaluate(() =>
      [...document.querySelectorAll("iframe,a,[data-src],[data-video-id],[data-youtube-id]")].map((n) =>
        [n.getAttribute("src"), n.getAttribute("data-src"), n.getAttribute("href"), n.getAttribute("data-video-id") && "v=" + n.getAttribute("data-video-id"), n.getAttribute("data-youtube-id") && "v=" + n.getAttribute("data-youtube-id")].filter(Boolean).join(" ")
      )
    ).catch(() => []);
    attrs.forEach((a) => a.split(" ").forEach(pick));
    t.found = [...found].slice(0, 12);
    const sh = await page.evaluate(() => document.documentElement.scrollHeight);
    const height = Math.floor(Math.min(t.height, sh - t.top));
    if (!(height >= 1)) throw new Error(`clip height invalid (scrollHeight=${sh}, top=${t.top})`);
    await page.screenshot({
      path: `${OUT}/${t.key}.jpg`, type: "jpeg", quality: 70,
      clip: { x: 0, y: t.top, width: t.width, height }, fullPage: true,
    });
    shots[t.key] = { ok: true, at: now(), found: t.found };
    console.log(`OK   ${t.key}`);
  } catch (e) {
    shots[t.key] = { ok: false, at: now(), error: short(e), found: t.found };
    console.log(`FAIL ${t.key}: ${short(e)}`);
  } finally {
    await context.close().catch(() => {});
  }
}
const queue = [...pages];
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await shoot(queue.shift()); }));
await browser.close();

await writeFile(`${OUT}/index.json`, JSON.stringify({ generatedAt: now(), shots }, null, 2) + "\n", "utf8");
const ok = Object.values(shots).filter((s) => s.ok).length;
console.log(`done: ${ok}/${Object.keys(shots).length} ok`);
if (ok === 0) process.exit(1);
