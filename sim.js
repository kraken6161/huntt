#!/usr/bin/env node
"use strict";
/* =========================================================================
   sim.js — Duck Proto mermi ekonomisi simülasyonu (görselsiz, bağımlılıksız)
   Oyunun CONFIG'ini index.html'den okur (tek kaynak), verilen isabet
   oranlarıyla N run simüle eder ve dengeyi raporlar.

   Kullanım:
     node sim.js
     node sim.js --runs=1000 --acc=0.5,0.65,0.8 --seed=7
     node sim.js --verbose        (tur tur detay tablosu)
   ========================================================================= */

const fs = require("fs");
const path = require("path");

/* ---- simülasyonun kendi varsayımları (oyunda karşılığı olmayan sayılar) ---- */
const SIM = {
  screenW: 400,          // px, dikey telefon
  screenH: 800,
  dt: 1 / 20,            // simülasyon adımı (sn)
  shotInterval: 0.45,    // oyuncunun iki atış arası nişan süresi (sn)
  acquireDelay: 0.20,    // ördek ekrana girdikten sonra atışa uygun hale gelme süresi (sn)
  maxRounds: 60,         // güvenlik sınırı
  maxRunSeconds: 3600    // güvenlik sınırı
};

/* ---- CLI ---- */
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? "true" : m[2]] : [a, "true"];
}));
const RUNS = parseInt(args.runs || "1000", 10);
const ACCS = (args.acc || "0.5,0.65,0.8").split(",").map(Number);
const SEED0 = parseInt(args.seed || "1", 10);
const VERBOSE = args.verbose === "true";

/* ---- CONFIG'i index.html'den çek ---- */
function loadConfig(file) {
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf("const CONFIG = {");
  if (start < 0) throw new Error("index.html içinde CONFIG bulunamadı");
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error("CONFIG bloğu kapanmıyor");
  // eslint-disable-next-line no-new-func
  return new Function("return " + src.slice(open, end + 1))();
}
const CONFIG_FILE = path.resolve(__dirname, args.config || "index.html");
const CONFIG = loadConfig(CONFIG_FILE);

/* ---- deterministik RNG ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- oyunun tur ölçekleri (index.html ile birebir) ---- */
const speedMul = r => Math.pow(1 + CONFIG.difficulty.speedGrowth, r - 1);
const spawnMul = r => Math.max(0.12, Math.pow(1 - CONFIG.difficulty.spawnGrowth, r - 1));
const sizeMul  = r => Math.max(CONFIG.duck.minScale, Math.pow(1 - CONFIG.difficulty.sizeShrink, r - 1));
const goalFor  = r => Math.round(CONFIG.round.goal + CONFIG.round.goalGrowth * (r - 1));

/* Turu geçmek için teorik olarak gereken isabet oranı */
function neededAcc(r) {
  const net = 1 - CONFIG.ammo.refundOnHit;      // isabet başına net mermi maliyeti
  const goal = goalFor(r);
  const spare = CONFIG.ammo.poolSize - 1 - goal * net;
  return spare <= 0 ? 1 : goal / (goal + spare);
}

/* ---- tek ördeğin havada kalma süresi (oyundaki yolun basit karşılığı) ---- */
function duckLifetime(rnd, round) {
  const c = CONFIG.duck;
  const w = c.width * sizeMul(round), h = c.height * sizeMul(round);
  const margin = Math.max(w, h) + c.waveAmplitude + 30;
  const speed = Math.max(20, c.speed * speedMul(round) * (1 + (rnd() * 2 - 1) * c.speedJitter));
  const fromBottom = rnd() < 0.5;
  if (fromBottom) {
    const a = (rnd() * 2 - 1) * 0.55;
    return (SIM.screenH + 2.1 * margin) / (speed * Math.max(0.3, Math.cos(a)));
  }
  const a = 0.05 + rnd() * 0.40;
  return (SIM.screenW + 2.6 * margin) / (speed * Math.max(0.3, Math.cos(a)));
}

function spawnDelay(rnd, round) {
  const base = CONFIG.spawn.interval * spawnMul(round);
  const j = CONFIG.spawn.intervalJitter;
  return Math.max(CONFIG.spawn.minInterval, base * (1 + (rnd() * 2 - 1) * j)) / 1000;
}

/* =========================================================================
   Tek run
   Oyuncu politikası: nişan süresi dolduğunda, ekrandaki en çok kaçmaya yakın
   ördeğe ateş eder; verilen isabet oranıyla vurur. Ördek varken beklemez.
   ========================================================================= */
function simulateRun(acc, seed) {
  const rnd = mulberry32(seed);
  const dt = SIM.dt;

  let t = 0, round = 1, runScore = 0;
  let ammo = Math.max(1, Math.round(CONFIG.ammo.poolSize));
  let shots = 0, hits = 0, escaped = 0, peakCombo = 1, comboSum = 0;
  const ammoSeries = [];      // [saniye, mermi]
  const rounds = [];          // tur tur özet
  let alive = true;

  while (alive && round <= SIM.maxRounds && t < SIM.maxRunSeconds) {
    const goal = goalFor(round);
    if (CONFIG.ammo.refillEachRound >= 0.5) ammo = Math.max(1, Math.round(CONFIG.ammo.poolSize));

    let combo = 1, sinceShot = 0, roundHits = 0, roundShots = 0, roundScore = 0;
    let roundT = 0, cooldown = 0, spawnTimer = CONFIG.spawn.firstDelay / 1000;
    const ammoStart = ammo;
    const ducks = [];         // {age, life}
    let roundOver = false, cleared = false;

    while (!roundOver && t < SIM.maxRunSeconds) {
      t += dt; roundT += dt; sinceShot += dt; cooldown -= dt;
      if (ammoSeries.length < Math.floor(t)) ammoSeries.push([Math.floor(t), ammo]);

      // kombo zamanla düşer
      if (combo > 1 && sinceShot >= CONFIG.combo.decayTime) {
        combo = Math.max(1, combo - CONFIG.combo.step);
        sinceShot = 0;
      }

      // spawn
      spawnTimer -= dt;
      if (spawnTimer <= 0 && ducks.length < Math.round(CONFIG.spawn.maxAlive)) {
        ducks.push({ age: 0, life: duckLifetime(rnd, round) });
        spawnTimer = spawnDelay(rnd, round);
      }

      // ördekleri yaşlandır / kaçır
      for (let i = ducks.length - 1; i >= 0; i--) {
        ducks[i].age += dt;
        if (ducks[i].age >= ducks[i].life) { ducks.splice(i, 1); escaped++; }
      }

      // ateş
      if (cooldown <= 0) {
        let target = -1, worst = Infinity;
        for (let i = 0; i < ducks.length; i++) {
          if (ducks[i].age < SIM.acquireDelay) continue;
          const remain = ducks[i].life - ducks[i].age;
          if (remain < worst) { worst = remain; target = i; }
        }
        if (target >= 0) {
          cooldown = SIM.shotInterval;
          sinceShot = 0;
          ammo -= 1; shots++; roundShots++;
          if (rnd() < acc) {
            ammo += CONFIG.ammo.refundOnHit;
            hits++; roundHits++;
            const gain = Math.round(CONFIG.score.perDuck * combo);
            roundScore += gain; runScore += gain;
            comboSum += combo;
            combo = Math.min(CONFIG.combo.max, combo + CONFIG.combo.step);
            if (combo > peakCombo) peakCombo = combo;
            ducks.splice(target, 1);
          } else {
            combo = 1;
          }
          if (ammo <= 0) { roundOver = true; alive = false; }
          else if (roundHits >= goal) { roundOver = true; cleared = true; }
        }
      }
    }

    rounds.push({
      round, goal, cleared, roundT, roundShots, roundHits, roundScore,
      ammoStart, ammoEnd: ammo, acc: roundShots ? roundHits / roundShots : 0
    });
    if (!alive) break;
    round++;
  }

  return {
    duration: t, roundReached: round, roundsCleared: rounds.filter(r => r.cleared).length,
    score: runScore, shots, hits, misses: shots - hits, escaped,
    peakCombo, avgCombo: hits ? comboSum / hits : 1,
    ammoSeries, rounds
  };
}

/* ---- istatistik yardımcıları ---- */
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const mmss = s => Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
const bar = (v, maxV, width) => "█".repeat(Math.max(0, Math.round((v / (maxV || 1)) * width)));
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

/* ---- rapor ---- */
function report() {
  const C = CONFIG;
  console.log("\n" + "═".repeat(78));
  console.log("DUCK PROTO — MERMİ EKONOMİSİ SİMÜLASYONU");
  console.log("═".repeat(78));
  console.log("config kaynağı : " + path.basename(CONFIG_FILE) + "   (runs: " + RUNS + ", seed: " + SEED0 + ")");
  console.log("havuz " + C.ammo.poolSize + " · isabet iadesi " + C.ammo.refundOnHit +
              " · her tur dolum " + (C.ammo.refillEachRound >= 0.5 ? "AÇIK" : "KAPALI") +
              " · hedef " + C.round.goal + " (+" + C.round.goalGrowth + "/tur)");
  console.log("kombo +" + C.combo.step + " kademe, max x" + C.combo.max + ", " + C.combo.decayTime +
              " sn'de bir kademe düşer · ördek puanı " + C.score.perDuck);
  console.log("zorluk: hız +" + Math.round(C.difficulty.speedGrowth * 100) + "%/tur, spawn -" +
              Math.round(C.difficulty.spawnGrowth * 100) + "%/tur, boyut -" +
              Math.round(C.difficulty.sizeShrink * 100) + "%/tur (min x" + C.duck.minScale + ")");
  console.log("oyuncu modeli  : " + SIM.shotInterval + " sn'de bir atış, en çok kaçmaya yakın ördeği hedefler");

  // analitik gereklilik tablosu
  console.log("\n── Turu geçmek için teorik olarak gereken isabet oranı ──");
  let line = "";
  for (let r = 1; r <= 12; r++) line += padr("T" + r + " " + Math.round(neededAcc(r) * 100) + "%", 9);
  console.log(line);
  console.log("(hedef " + goalFor(1) + " → " + goalFor(12) + " ördek; havuz sabit " + C.ammo.poolSize + ")");

  const all = [];
  for (const acc of ACCS) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(simulateRun(acc, SEED0 * 1000003 + i * 7919 + Math.round(acc * 100)));
    all.push({ acc, runs });
  }

  for (const { acc, runs } of all) {
    const dur = runs.map(r => r.duration).sort((a, b) => a - b);
    const scr = runs.map(r => r.score).sort((a, b) => a - b);
    const rr  = runs.map(r => r.roundsCleared).sort((a, b) => a - b);

    console.log("\n" + "─".repeat(78));
    console.log("İSABET ORANI %" + Math.round(acc * 100) + "   (" + RUNS + " run)");
    console.log("─".repeat(78));

    console.log("run süresi     ort " + mmss(mean(dur)) + "   medyan " + mmss(pct(dur, 0.5)) +
                "   p10 " + mmss(pct(dur, 0.1)) + "   p90 " + mmss(pct(dur, 0.9)) +
                "   |  hedef 15–20 dk: %" + Math.round(100 * dur.filter(d => d >= 900 && d <= 1200).length / dur.length));
    console.log("temizlenen tur ort " + mean(rr).toFixed(2) + "   medyan " + pct(rr, 0.5) +
                "   p10 " + pct(rr, 0.1) + "   p90 " + pct(rr, 0.9) + "   max " + rr[rr.length - 1]);
    console.log("final skor     ort " + Math.round(mean(scr)) + "   medyan " + pct(scr, 0.5) +
                "   p10 " + pct(scr, 0.1) + "   p90 " + pct(scr, 0.9) + "   max " + scr[scr.length - 1]);
    console.log("kombo          ulaşılan ort x" + mean(runs.map(r => r.avgCombo)).toFixed(2) +
                "   zirve ort x" + mean(runs.map(r => r.peakCombo)).toFixed(2) +
                "   zirve max x" + Math.max(...runs.map(r => r.peakCombo)).toFixed(1));
    console.log("atış           " + Math.round(mean(runs.map(r => r.shots))) + " atış / " +
                Math.round(mean(runs.map(r => r.hits))) + " isabet / " +
                Math.round(mean(runs.map(r => r.misses))) + " ıska   ·  kaçan ördek " +
                mean(runs.map(r => r.escaped)).toFixed(1) +
                "  ·  gerçekleşen ıska oranı %" + Math.round(100 * mean(runs.map(r => r.misses / Math.max(1, r.shots)))));

    // temizlenen tur dağılımı
    const hist = {};
    for (const v of rr) hist[v] = (hist[v] || 0) + 1;
    const maxH = Math.max(...Object.values(hist));
    console.log("\n  temizlenen tur dağılımı");
    Object.keys(hist).map(Number).sort((a, b) => a - b).forEach(k => {
      console.log("   " + pad(k, 3) + " tur │" + padr(bar(hist[k], maxH, 34), 34) + "│ " +
                  pad((100 * hist[k] / runs.length).toFixed(1) + "%", 6));
    });

    // skor dağılımı
    console.log("\n  final skor dağılımı");
    const smin = scr[0], smax = scr[scr.length - 1], bins = 8, step = Math.max(1, (smax - smin) / bins);
    const sh = new Array(bins).fill(0);
    for (const v of scr) sh[Math.min(bins - 1, Math.floor((v - smin) / step))]++;
    const maxS = Math.max(...sh);
    for (let i = 0; i < bins; i++) {
      const lo = Math.round(smin + i * step), hi = Math.round(smin + (i + 1) * step);
      console.log("   " + padr(lo + "–" + hi, 15) + "│" + padr(bar(sh[i], maxS, 34), 34) + "│ " +
                  pad((100 * sh[i] / scr.length).toFixed(1) + "%", 6));
    }

    // mermi havuzunun seyri: tur tur
    const maxRound = Math.max(...runs.map(r => r.rounds.length));
    console.log("\n  tur tur seyir (ortalama, o tura ulaşan run'lar üzerinden)");
    console.log("   tur  hedef  ulaşan%   süre   atış  isabet   ıska  mermi(baş→son)  tur skoru");
    for (let i = 0; i < Math.min(maxRound, 12); i++) {
      const rs = runs.map(r => r.rounds[i]).filter(Boolean);
      if (!rs.length) break;
      console.log("   " + pad(i + 1, 3) + pad(rs[0].goal, 7) +
        pad(Math.round(100 * rs.length / runs.length) + "%", 9) +
        pad(mean(rs.map(r => r.roundT)).toFixed(1) + "s", 8) +
        pad(mean(rs.map(r => r.roundShots)).toFixed(1), 7) +
        pad(mean(rs.map(r => r.roundHits)).toFixed(1), 8) +
        pad(mean(rs.map(r => r.roundShots - r.roundHits)).toFixed(1), 7) +
        pad(mean(rs.map(r => r.ammoStart)).toFixed(1) + "→" + mean(rs.map(r => r.ammoEnd)).toFixed(1), 16) +
        pad(Math.round(mean(rs.map(r => r.roundScore))), 11));
    }

    // mermi havuzunun zaman içindeki seyri
    console.log("\n  mermi havuzu — zaman içinde (hayatta olan run'ların ortalaması)");
    const buckets = 12, bw = 10; // 10 saniyelik kovalar
    for (let b = 0; b < buckets; b++) {
      const lo = b * bw, hi = lo + bw;
      const vals = [];
      for (const r of runs) for (const [sec, am] of r.ammoSeries) if (sec >= lo && sec < hi) vals.push(am);
      if (!vals.length) break;
      const m = mean(vals);
      console.log("   " + padr(lo + "–" + hi + "s", 10) + "│" + padr(bar(m, CONFIG.ammo.poolSize, 30), 30) +
                  "│ " + m.toFixed(1) + " mermi   (yaşayan run %" +
                  Math.round(100 * runs.filter(r => r.duration >= lo).length / runs.length) + ")");
    }

    if (VERBOSE) {
      console.log("\n  örnek run (ilk seed):");
      const r0 = runs[0];
      for (const rd of r0.rounds) {
        console.log("    T" + pad(rd.round, 2) + " hedef " + pad(rd.goal, 2) +
          " → " + pad(rd.roundHits, 2) + " isabet / " + pad(rd.roundShots, 2) + " atış" +
          "  mermi " + pad(rd.ammoStart, 2) + "→" + pad(rd.ammoEnd, 3) +
          "  " + pad(rd.roundT.toFixed(1) + "s", 7) + "  skor " + pad(rd.roundScore, 5) +
          (rd.cleared ? "  ✓" : "  ✗ run bitti"));
      }
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log("Not: isabet oranı simülasyonun girdisi olduğu için 'ıska oranı %20–30' ilkesi");
  console.log("bu modelle test edilemez; model bunun yerine hangi oranın hangi tura kadar");
  console.log("yettiğini gösterir. Ördek boyutunun küçülmesi isabet oranını etkilemez.");
  console.log("═".repeat(78) + "\n");
}

report();
