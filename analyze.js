#!/usr/bin/env node
"use strict";
/* =========================================================================
   analyze.js — Duck Proto telemetri analizi (bağımlılıksız)

   telemetry/ klasöründeki tüm .json export dosyalarını okur, run'ları
   configHash'e göre gruplar ve grupları yan yana raporlar:
     1. Model doğrulaması   — öngörülen p kutuları vs. gerçek isabet oranı
     2. Gerçek eşiğim       — ateş edilen atışların p dağılımı, sim optimumu
     3. Ölüm anatomisi      — son 10 sn mermi eğrisi, son 5 atışın p'si
     4. Kombo kullanımı     — zamanın yüzde kaçı hangi çarpanda geçti
     5. Yorgunluk           — run-run isabet oranı ve dakikadaki atış trendi

   Kullanım:
     node analyze.js
     node analyze.js --dir=telemetry/samples
     node analyze.js --sim=sim-optimum.json
   ========================================================================= */

const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? "true" : m[2]] : [a, "true"];
}));
const DIR = path.resolve(__dirname, args.dir || "telemetry");
const SIM_FILE = path.resolve(__dirname, args.sim || "sim-optimum.json");

/* ---- yardımcılar ---- */
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sorted = a => a.slice().sort((x, y) => x - y);
const pct = (s, p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);
const bar = (v, maxV, w) => "█".repeat(Math.max(0, Math.round((v / (maxV || 1)) * w)));
const mmss = s => Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
const p1 = v => (v == null || isNaN(v)) ? "  —  " : v.toFixed(2);
const pctS = v => (v == null || isNaN(v)) ? "—" : "%" + Math.round(v * 100);

/* ---- dosyaları oku ---- */
function loadFiles(dir) {
  if (!fs.existsSync(dir)) { console.error("Klasör yok: " + dir); process.exit(1); }
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".json") && !f.startsWith("_"))
    .map(f => path.join(dir, f));
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!data || !Array.isArray(data.runs)) { console.error("atlandı (biçim): " + path.basename(f)); continue; }
      out.push({ file: path.basename(f), meta: data.meta || {}, runs: data.runs });
    } catch (e) { console.error("atlandı (bozuk JSON): " + path.basename(f)); }
  }
  return out;
}

/* ---- grupla: configHash ---- */
function group(files) {
  const groups = new Map();
  for (const f of files) {
    for (const run of f.runs) {
      const hash = run.configHash || f.meta.configHash || "bilinmeyen";
      if (!groups.has(hash)) groups.set(hash, { hash, runs: [], files: new Set(), config: run.config || f.meta.config });
      const g = groups.get(hash);
      g.runs.push(run);
      g.files.add(f.file);
    }
  }
  for (const g of groups.values()) {
    g.runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    g.shots = [];
    g.runs.forEach((r, i) => (r.shots || []).forEach(s => g.shots.push(Object.assign({ _run: i }, s))));
    g.rounds = [];
    g.runs.forEach((r, i) => (r.rounds || []).forEach(x => g.rounds.push(Object.assign({ _run: i }, x))));
  }
  return [...groups.values()].sort((a, b) => b.runs.length - a.runs.length);
}

/* ---- kolon düzeni ---- */
const COLW = 22, LABELW = 30;
function cols(groups, label, fn) {
  let row = padr(label, LABELW);
  for (const g of groups) row += padr(fn(g), COLW);
  console.log("  " + row.trimEnd());
}
function head(groups, title) {
  console.log("\n" + "─".repeat(LABELW + COLW * groups.length));
  let row = padr(title, LABELW);
  for (const g of groups) row += padr(g.hash + " (" + g.runs.length + " run)", COLW);
  console.log("  " + row.trimEnd());
  console.log("  " + "─".repeat(LABELW + COLW * groups.length - 2));
}

const MIN_SHOTS = 5;                       // bunun altındaki run "yarım" sayılır
const realRuns = g => g.runs.filter(r => (r.shots || []).length >= MIN_SHOTS);
function shotGaps(runs) {
  const gaps = [];
  for (const r of runs) {
    const ts = (r.shots || []).map(s => s.t).sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i-1]; if (d > 0 && d < 15) gaps.push(d); }
  }
  return sorted(gaps);
}

/* ========================= 0. özet ========================= */
function summary(groups, files) {
  console.log("\n" + "═".repeat(78));
  console.log("DUCK PROTO — TELEMETRİ ANALİZİ");
  console.log("═".repeat(78));
  console.log("kaynak: " + path.relative(process.cwd(), DIR) + "  ·  " + files.length + " dosya  ·  " +
    groups.length + " config grubu");
  for (const g of groups) {
    const c = g.config || {};
    const a = c.ammo || {}, r = c.round || {}, m = c.model || {};
    console.log("  " + g.hash + "  havuz " + a.poolSize + " · ıska −" + a.missCost + " · kaçış −" + a.escapeCost +
      " · hedef " + r.goal + "+" + r.goalGrowth + " · model skill " + m.skill +
      "   [" + [...g.files].join(", ") + "]");
  }

  head(groups, "ÖZET");
  cols(groups, "run", g => g.runs.length);
  cols(groups, "toplam atış", g => g.shots.length);
  cols(groups, "isabet oranı", g => pctS(mean(g.shots.map(s => s.hit ? 1 : 0))));
  cols(groups, "ort. skor", g => Math.round(mean(g.runs.map(r => r.score || 0))));
  cols(groups, "ort. temizlenen tur", g => mean(g.runs.map(r => r.roundsCleared || 0)).toFixed(2));
  cols(groups, "ort. run süresi", g => mmss(mean(g.runs.map(r => r.duration || 0))));
  cols(groups, "ort. kaçan ördek", g => mean(g.runs.map(r => r.escapedCount || 0)).toFixed(1));
  cols(groups, "atış temposu (medyan)", g => {
    const gp = shotGaps(realRuns(g));
    return gp.length ? pct(gp, 0.5).toFixed(2) + " sn" : "—";
  });
  cols(groups, "hedefsiz (boşa) atış", g => {
    const n = g.shots.filter(x => x.p == null).length;
    return n + " (" + Math.round(100 * n / Math.max(1, g.shots.length)) + "%)";
  });
  cols(groups, "yarım run (<" + MIN_SHOTS + " atış)", g => g.runs.length - realRuns(g).length);
  cols(groups, "oyun sürümü", g => [...new Set(g.runs.map(r => r.gameVersion))].join(","));
  cols(groups, "cihaz", g => [...new Set(g.runs.map(r => (r.device || {}).type))].join(","));
}

/* ================== 1. model doğrulaması ================== */
function calibration(groups) {
  console.log("\n" + "═".repeat(78));
  console.log("1 · MODEL DOĞRULAMASI — öngörülen p vs. gerçek isabet");
  console.log("═".repeat(78));
  console.log("  Model doğruysa her kutuda gerçek isabet ≈ kutunun ortası olmalı (çapraz çizgi).");

  for (const g of groups) {
    const shots = g.shots.filter(s => typeof s.p === "number");
    const blind = g.shots.length - shots.length;
    console.log("\n  ── " + g.hash + " ── " + shots.length + " hedefli atış" +
      (blind ? "  (+" + blind + " boşa atış, hedefsiz — hariç)" : ""));
    if (!shots.length) { console.log("     veri yok"); continue; }
    console.log("     p kutusu    n    öngörü  gerçek   sapma   grafik (öngörü ▏ gerçek █)");
    let errW = 0, brier = 0;
    for (let b = 0; b < 10; b++) {
      const lo = b / 10, hi = lo + 0.1;
      const inBin = shots.filter(s => s.p >= lo && (b === 9 ? s.p <= hi : s.p < hi));
      if (!inBin.length) continue;
      const predicted = mean(inBin.map(s => s.p));
      const actual = mean(inBin.map(s => s.hit ? 1 : 0));
      errW += inBin.length * Math.abs(actual - predicted);
      const w = 30;
      const gi = Math.round(predicted * w), ga = Math.round(actual * w);
      let g2 = "";
      for (let i = 0; i < w; i++) g2 += (i === gi && i === ga) ? "▓" : (i === gi ? "▏" : (i < ga ? "█" : "·"));
      console.log("     " + padr(lo.toFixed(1) + "–" + hi.toFixed(1), 11) + pad(inBin.length, 4) +
        pad(predicted.toFixed(2), 9) + pad(actual.toFixed(2), 8) +
        pad((actual - predicted >= 0 ? "+" : "") + (actual - predicted).toFixed(2), 8) + "   " + g2);
    }
    for (const s of shots) brier += Math.pow(s.p - (s.hit ? 1 : 0), 2);
    const sumQ = shots.reduce((a, s) => a + (typeof s.q === "number" ? s.q : 0), 0);
    const hits = shots.filter(s => s.hit).length;
    const measuredSkill = sumQ > 0 ? hits / sumQ : null;
    const cfgSkill = ((g.config || {}).model || {}).skill;
    console.log("     kalibrasyon hatası (ağırlıklı |gerçek−öngörü|): " + (errW / shots.length).toFixed(3) +
      "   ·   Brier: " + (brier / shots.length).toFixed(3));
    if (measuredSkill != null) {
      console.log("     ölçülen beceri (isabet/Σq): " + measuredSkill.toFixed(2) +
        "   ·   CONFIG.model.skill: " + cfgSkill +
        (cfgSkill ? "   → model " + (measuredSkill > cfgSkill ? "seni hafife alıyor" : "seni fazla iyimser sanıyor") +
          " (×" + (measuredSkill / cfgSkill).toFixed(2) + ")" : ""));
    }
  }
}

/* ================== 2. gerçek eşik ================== */
function threshold(groups, sim) {
  console.log("\n" + "═".repeat(78));
  console.log("2 · GERÇEK EŞİĞİM — ateş ettiğim atışların p dağılımı");
  console.log("═".repeat(78));
  if (sim) {
    console.log("  sim.js optimumları:  " + sim.skills.map(s =>
      s.name + " " + s.optimalThreshold.toFixed(2) + (s.cleanThreshold !== s.optimalThreshold ?
      " (tıkanmasız " + s.cleanThreshold.toFixed(2) + ")" : "")).join("   ·   "));
  } else {
    console.log("  (sim-optimum.json yok — karşılaştırma için: node sim.js --emit=sim-optimum.json)");
  }

  head(groups, "p İSTATİSTİĞİ");
  const stat = g => sorted(g.shots.filter(s => typeof s.p === "number").map(s => s.p));
  cols(groups, "en düşük p (aldığım)", g => p1(stat(g)[0]));
  cols(groups, "p10", g => p1(pct(stat(g), 0.10)));
  cols(groups, "medyan p", g => p1(pct(stat(g), 0.50)));
  cols(groups, "ortalama p", g => p1(mean(stat(g))));
  cols(groups, "p90", g => p1(pct(stat(g), 0.90)));
  cols(groups, "ölçülen beceri (isabet/Σq)", g => {
    const sh = g.shots.filter(x => typeof x.q === "number");
    const sq = sh.reduce((a, x) => a + x.q, 0);
    return sq > 0 ? (sh.filter(x => x.hit).length / sq).toFixed(2) : "—";
  });
  if (sim) {
    // Sim eşikleri p = beceri × q üzerinden tanımlı. Kayıttaki p, o oturumun
    // model.skill'iyle hesaplandı; karşılaştırmayı q'ya dönüp sim'in becerisiyle
    // yeniden ölçekleyerek yapıyoruz (elma-elma).
    console.log("  " + padr("(karşılaştırma q × sim becerisi üzerinden yeniden ölçeklendi)", LABELW + COLW).trimEnd());
    for (const sk of sim.skills) {
      cols(groups, "eşik " + sk.optimalThreshold.toFixed(2) + " altı (" + sk.name + " " + sk.skill + ")", g => {
        const qs = g.shots.filter(x => typeof x.q === "number").map(x => x.q * sk.skill);
        if (!qs.length) return "—";
        return pctS(qs.filter(v => v < sk.optimalThreshold).length / qs.length);
      });
    }
    cols(groups, "kayıttaki model.skill", g => ((g.config || {}).model || {}).skill);
  }

  for (const g of groups) {
    const a = stat(g);
    if (!a.length) continue;
    console.log("\n  ── " + g.hash + " ── p histogramı (aldığım atışlar)");
    const bins = new Array(10).fill(0);
    for (const v of a) bins[Math.min(9, Math.floor(v * 10))]++;
    const mx = Math.max(...bins);
    for (let b = 0; b < 10; b++) {
      if (!bins[b]) continue;
      console.log("     " + padr((b / 10).toFixed(1) + "–" + ((b + 1) / 10).toFixed(1), 10) +
        "│" + padr(bar(bins[b], mx, 34), 34) + "│ " + pad(bins[b], 4) +
        pad(Math.round(100 * bins[b] / a.length) + "%", 6));
    }
  }
}

/* ================== 3. ölüm anatomisi ================== */
function death(groups) {
  console.log("\n" + "═".repeat(78));
  console.log("3 · ÖLÜM ANATOMİSİ — run bitmeden önceki 10 saniye");
  console.log("═".repeat(78));

  for (const g of groups) {
    const dead = g.runs.filter(r => r.endReason && !/abandoned|yarım/.test(r.endReason));
    console.log("\n  ── " + g.hash + " ── " + dead.length + " tamamlanmış run");
    if (!dead.length) { console.log("     veri yok"); continue; }

    const causes = {};
    for (const r of dead) causes[r.endReason] = (causes[r.endReason] || 0) + 1;
    console.log("     ölüm sebebi: " + Object.entries(causes)
      .map(([k, v]) => k + " ×" + v + " (" + Math.round(100 * v / dead.length) + "%)").join("  ·  "));

    // son 10 sn mermi eğrisi
    const grid = new Array(11).fill(null).map(() => []);
    for (const r of dead) {
      const curve = [];
      for (const rd of r.rounds || []) for (const [t, a] of rd.ammoCurve || []) curve.push([t, a]);
      if (!curve.length) continue;
      curve.sort((x, y) => x[0] - y[0]);
      const tEnd = r.duration || curve[curve.length - 1][0];
      for (let k = 0; k <= 10; k++) {
        const t = tEnd - (10 - k);
        if (t < 0) continue;
        let v = null;
        for (const [ct, ca] of curve) { if (ct <= t) v = ca; else break; }
        if (v != null) grid[k].push(v);
      }
    }
    const maxA = Math.max(1, ...grid.map(a => (a.length ? mean(a) : 0)));
    console.log("     mermi eğrisi (ölümden önce):");
    for (let k = 0; k <= 10; k++) {
      if (!grid[k].length) continue;
      const m = mean(grid[k]);
      console.log("       " + padr("T−" + (10 - k) + "s", 6) + "│" + padr(bar(m, maxA, 26), 26) + "│ " + m.toFixed(1));
    }

    // son 5 atışın p'si
    const pos = [[], [], [], [], []];
    let allP = [];
    for (const r of dead) {
      const ss = (r.shots || []).filter(s => typeof s.p === "number");
      allP = allP.concat(ss.map(s => s.p));
      const last = ss.slice(-5);
      for (let i = 0; i < last.length; i++) pos[5 - last.length + i].push(last[i].p);
    }
    console.log("     son 5 atışın p'si (ort " + (allP.length ? mean(allP).toFixed(2) : "—") + " genel ortalamaya karşı):");
    let row = "       ";
    for (let i = 0; i < 5; i++) row += padr("-" + (5 - i) + ": " + (pos[i].length ? mean(pos[i]).toFixed(2) : "—"), 11);
    console.log(row);

    // mermiyi ne tüketti: ıska mı, kaçış mı
    const cfg = g.config || {}, am = cfg.ammo || {};
    const mc = am.missCost || 1, ec = am.escapeCost || 0;
    let missAmmo = 0, escAmmo = 0;
    for (const r of dead) {
      missAmmo += (r.shots || []).filter(s => !s.hit).length * mc;
      escAmmo += (r.duckEvents || []).filter(e => e.ev === "escape").length * ec;
    }
    const tot = missAmmo + escAmmo;
    if (tot) {
      console.log("     mermiyi ne tüketti: ıska " + missAmmo + " mermi (%" + Math.round(100 * missAmmo / tot) +
        ")  ·  kaçış " + escAmmo + " mermi (%" + Math.round(100 * escAmmo / tot) + ")" +
        "   [ıska −" + mc + ", kaçış −" + ec + "]");
      console.log("     not: bitiş sebebi son damlayı söyler, tüketimin çoğunu değil.");
    }

    // son 10 sn'de kaçan ördek
    const escLate = dead.map(r => {
      const tEnd = r.duration || 0;
      return (r.duckEvents || []).filter(e => e.ev === "escape" && e.t >= tEnd - 10).length;
    });
    console.log("     son 10 sn'de kaçan ördek: ort " + mean(escLate).toFixed(1) +
      "  ·  son 10 sn'deki atış: ort " +
      mean(dead.map(r => (r.shots || []).filter(s => s.t >= (r.duration || 0) - 10).length)).toFixed(1));
  }
}

/* ================== 4. kombo kullanımı ================== */
function comboUsage(groups) {
  console.log("\n" + "═".repeat(78));
  console.log("4 · KOMBO KULLANIMI — zamanın yüzde kaçı hangi çarpanda geçti");
  console.log("═".repeat(78));

  const tables = groups.map(g => {
    const acc = new Map();
    let total = 0;
    for (const rd of g.rounds) {
      const c = (rd.comboCurve || []).slice().sort((a, b) => a[0] - b[0]);
      const end = rd.t0 + rd.dur;
      for (let i = 0; i < c.length; i++) {
        const t = Math.max(c[i][0], rd.t0);
        const t2 = Math.min(i + 1 < c.length ? c[i + 1][0] : end, end);
        const d = Math.max(0, t2 - t);
        if (!d) continue;
        const v = c[i][1];
        acc.set(v, (acc.get(v) || 0) + d);
        total += d;
      }
    }
    return { g, acc, total };
  });

  const values = [...new Set(tables.flatMap(t => [...t.acc.keys()]))].sort((a, b) => a - b);
  head(groups, "ÇARPANDA GEÇEN SÜRE");
  for (const v of values) {
    cols(groups, "x" + v.toFixed(1), g => {
      const t = tables.find(x => x.g === g);
      const s = t.acc.get(v) || 0;
      return t.total ? "%" + Math.round(100 * s / t.total) + " " + bar(s, t.total, 10) : "—";
    });
  }
  cols(groups, "ağırlıklı ort. çarpan", g => {
    const t = tables.find(x => x.g === g);
    if (!t.total) return "—";
    let sum = 0;
    for (const [v, d] of t.acc) sum += v * d;
    return "x" + (sum / t.total).toFixed(2);
  });
  cols(groups, "toplam oyun süresi", g => {
    const t = tables.find(x => x.g === g);
    return mmss(t.total);
  });
}

/* ================== 5. yorgunluk ================== */
function fatigue(groups) {
  console.log("\n" + "═".repeat(78));
  console.log("5 · YORGUNLUK — oturum boyunca run-run trend");
  console.log("═".repeat(78));

  for (const g of groups) {
    console.log("\n  ── " + g.hash + " ──");
    console.log("     #   başlangıç         süre    atış  isabet%  atış/dk  skor");
    const accs = [], rates = [];
    const full = realRuns(g);
    g.runs.forEach((r, i) => {
      const shots = (r.shots || []).length;
      const hits = (r.shots || []).filter(s => s.hit).length;
      const acc = shots ? hits / shots : 0;
      const dur = r.duration || 0;
      const rate = dur > 0 ? shots / (dur / 60) : 0;
      if (shots >= MIN_SHOTS) { accs.push(acc); rates.push(rate); }
      const ts = String(r.startedAt || "").replace("T", " ").slice(5, 16);
      console.log("     " + pad(i + 1, 2) + "  " + padr(ts, 17) + padr(mmss(dur), 8) +
        pad(shots, 5) + pad(Math.round(acc * 100) + "%", 8) + pad(rate.toFixed(1), 9) +
        pad(r.score || 0, 7) + "  " + (shots >= MIN_SHOTS ? bar(acc, 1, 12) : "yarım — trende dahil değil"));
    });
    if (accs.length >= 4) {
      const h = Math.floor(accs.length / 2);
      const slope = arr => {
        const n = arr.length, xm = (n - 1) / 2, ym = mean(arr);
        let num = 0, den = 0;
        arr.forEach((v, i) => { num += (i - xm) * (v - ym); den += (i - xm) * (i - xm); });
        return den ? num / den : 0;
      };
      console.log("     ilk yarı isabet %" + Math.round(100 * mean(accs.slice(0, h))) +
        " → son yarı %" + Math.round(100 * mean(accs.slice(h))) +
        "   (eğim " + (slope(accs) * 100 >= 0 ? "+" : "") + (slope(accs) * 100).toFixed(1) + " puan/run)");
      console.log("     ilk yarı atış/dk " + mean(rates.slice(0, h)).toFixed(1) +
        " → son yarı " + mean(rates.slice(h)).toFixed(1) +
        "   (eğim " + (slope(rates) >= 0 ? "+" : "") + slope(rates).toFixed(2) + "/run)");
    } else {
      console.log("     (trend için en az 4 dolu run gerek — şu an " + accs.length +
        (full.length !== g.runs.length ? "; " + (g.runs.length - full.length) + " yarım run sayılmadı" : "") + ")");
    }
  }
}

/* ---- çalıştır ---- */
const files = loadFiles(DIR);
if (!files.length) {
  console.error("\n" + DIR + " içinde export dosyası yok.\n" +
    "Oyundaki ⬇ Export butonuyla indirdiğin JSON'ları bu klasöre koy.\n");
  process.exit(1);
}
let sim = null;
try { sim = JSON.parse(fs.readFileSync(SIM_FILE, "utf8")); } catch (e) { sim = null; }

const groups = group(files);
summary(groups, files);
calibration(groups);
threshold(groups, sim);
death(groups);
comboUsage(groups);
fatigue(groups);
console.log("\n" + "═".repeat(78) + "\n");
