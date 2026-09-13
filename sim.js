#!/usr/bin/env node
"use strict";
/* =========================================================================
   sim.js — Duck Proto denge simülasyonu (görselsiz, bağımlılıksız)

   İki model yan yana çalışır:
     A) SABİT İSABET  — eski model. Isabet oranı dışarıdan verilir, oyuncu
        ekrandaki en çok kaçmaya yakın ördeğe her fırsatta ateş eder.
     B) ATIŞ KALİTESİ — her ördeğin her andaki isabet olasılığı boyutuna,
        hızına ve ekran merkezine uzaklığına bağlıdır. Oyuncunun bir beceri
        seviyesi ve bir eşiği vardır: eşiğin altındaki atışı atlar, üstündekini
        alır. Eşik 0'dan 0.9'a taranarak her beceri için optimum bulunur.

   Sorulan soru: optimal eşik 0'dan büyük mü? Büyükse "atışı atlamak" gerçek
   bir karardır ve çekirdek gerilim (acele etme / hızlı vur) çalışıyordur.

   Kullanım:
     node sim.js
     node sim.js --runs=1000 --sweepRuns=300 --seed=7 --verbose
   ========================================================================= */

const fs = require("fs");
const path = require("path");

/* ---- simülasyonun kendi varsayımları (oyunda karşılığı olmayan sayılar) ---- */
const SIM = {
  screenW: 400,           // px, dikey telefon
  screenH: 800,
  hudHeight: 156,         // üstteki HUD şeridi — arkasındaki ördek vurulamaz
  dt: 1 / 20,             // simülasyon adımı (sn)
  shotInterval: 0.45,     // iki atış arası nişan süresi (sn)
  acquireDelay: 0.20,     // ördek göründükten sonra atışa uygun hale gelme (sn)
  stallSeconds: 45,       // bu kadar süre hiç atış olmazsa run tıkandı sayılır
  maxRounds: 60,
  maxRunSeconds: 2400,

  // atış kalitesi modeli:  p = beceri × boyut × hız × merkez
  quality: {
    sizeExp:       0.80,  // p ∝ (ördek ölçeği)^sizeExp
    speedExp:      0.60,  // p ∝ (temel hız / ördek hızı)^speedExp
    centerPenalty: 0.35,  // ekranın en uzak köşesinde p bu oranda düşer
    minP:          0.02,
    maxP:          0.98
  },
  skills: [               // beceri = merkezdeki, temel boy ve hızdaki ördeğin tavan olasılığı
    { name: "düşük",  skill: 0.55 },
    { name: "orta",   skill: 0.75 },
    { name: "yüksek", skill: 0.92 }
  ],
  sweep: { from: 0, to: 0.9, step: 0.05 }
};

/* ---- CLI ---- */
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? "true" : m[2]] : [a, "true"];
}));
const RUNS = parseInt(args.runs || "1000", 10);
const SWEEP_RUNS = parseInt(args.sweepRuns || "300", 10);
const ACCS = (args.acc || "0.5,0.65,0.8").split(",").map(Number);
const SEED0 = parseInt(args.seed || "1", 10);
const VERBOSE = args.verbose === "true";

/* ---- CONFIG'i index.html'den çek (tek kaynak) ---- */
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
  return new Function("return " + src.slice(open, end + 1))();
}
const CONFIG_FILE = path.resolve(__dirname, args.config || "index.html");
const CONFIG = loadConfig(CONFIG_FILE);

/* ---- yardımcılar ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) * (v - m)))); };
const se = a => sd(a) / Math.sqrt(a.length || 1);
const sorted = a => a.slice().sort((x, y) => x - y);
const pct = (s, p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
const mmss = s => Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
const bar = (v, maxV, w) => "█".repeat(Math.max(0, Math.round((v / (maxV || 1)) * w)));
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

/* ---- oyunun tur ölçekleri (index.html ile birebir) ---- */
const speedMul = r => Math.pow(1 + CONFIG.difficulty.speedGrowth, r - 1);
const spawnMul = r => Math.max(0.12, Math.pow(1 - CONFIG.difficulty.spawnGrowth, r - 1));
const sizeMul  = r => Math.max(CONFIG.duck.minScale, Math.pow(1 - CONFIG.difficulty.sizeShrink, r - 1));
const goalFor  = r => Math.round(CONFIG.round.goal + CONFIG.round.goalGrowth * (r - 1));
const missCost = () => Math.max(1, Math.round(CONFIG.ammo.missCost === undefined ? 1 : CONFIG.ammo.missCost));

/* Turu geçmek için teorik olarak gereken isabet oranı */
function neededAcc(r) {
  const net = 1 - CONFIG.ammo.refundOnHit;
  const goal = goalFor(r);
  const budget = CONFIG.ammo.poolSize - 1 - goal * net;
  const maxMiss = Math.floor(budget / missCost());
  return maxMiss <= 0 ? 1 : goal / (goal + maxMiss);
}
const maxMissesFor = r => {
  const net = 1 - CONFIG.ammo.refundOnHit;
  return Math.max(0, Math.floor((CONFIG.ammo.poolSize - 1 - goalFor(r) * net) / missCost()));
};

/* ========================== ördek (oyunla aynı yol) ========================== */
function makeDuck(rnd, round) {
  const c = CONFIG.duck;
  const s = sizeMul(round);
  const w = c.width * s, h = c.height * s;
  const margin = Math.max(w, h) + c.waveAmplitude + 30;
  const speed = Math.max(20, c.speed * speedMul(round) * (1 + (rnd() * 2 - 1) * c.speedJitter));
  let ox, oy, dx, dy;
  if (rnd() < 0.5) {                                  // alttan
    ox = SIM.screenW * (0.12 + rnd() * 0.76);
    oy = SIM.screenH + margin * 0.5;
    const a = (rnd() * 2 - 1) * 0.55;
    dx = Math.sin(a); dy = -Math.cos(a);
  } else {                                            // yandan
    const left = rnd() < 0.5;
    ox = left ? -margin : SIM.screenW + margin;
    oy = SIM.screenH * (0.24 + rnd() * 0.48);
    const a = 0.05 + rnd() * 0.40;
    dx = (left ? 1 : -1) * Math.cos(a); dy = -Math.sin(a);
  }
  return {
    ox, oy, dx, dy, ppx: -dy, ppy: dx, speed, phase: rnd() * Math.PI * 2,
    age: 0, scale: s, x: ox, y: oy, entered: false, shotAt: false
  };
}

function stepDuck(d, dt) {
  const c = CONFIG.duck;
  d.age += dt;
  const travel = d.speed * d.age;
  const off = c.waveAmplitude * Math.sin(2 * Math.PI * c.waveFrequency * d.age + d.phase);
  d.x = d.ox + d.dx * travel + d.ppx * off;
  d.y = d.oy + d.dy * travel + d.ppy * off;
  const m = Math.max(c.width, c.height);
  if (d.x > -m && d.x < SIM.screenW + m && d.y > -m && d.y < SIM.screenH + m) d.entered = true;
  const gone = d.y < -m * 1.6 || d.x < -m * 1.6 || d.x > SIM.screenW + m * 1.6 || d.y > SIM.screenH + m * 3;
  return (d.entered && gone) || d.age > 18;
}

const shootable = d => d.age >= SIM.acquireDelay &&
  d.x > 0 && d.x < SIM.screenW && d.y > SIM.hudHeight && d.y < SIM.screenH;

/* ---- atış kalitesi: boyut × hız × merkeze uzaklık ---- */
const PLAY_CX = SIM.screenW / 2;
const PLAY_CY = SIM.hudHeight + (SIM.screenH - SIM.hudHeight) / 2;
const HALF_DIAG = Math.hypot(SIM.screenW / 2, (SIM.screenH - SIM.hudHeight) / 2);

function hitChance(d, skill) {
  const q = SIM.quality;
  const sizeF = Math.pow(d.scale, q.sizeExp);
  const spdF = Math.pow(CONFIG.duck.speed / d.speed, q.speedExp);
  const dist = Math.min(1, Math.hypot(d.x - PLAY_CX, d.y - PLAY_CY) / HALF_DIAG);
  const centerF = 1 - q.centerPenalty * dist;
  return clamp(skill * sizeF * spdF * centerF, q.minP, q.maxP);
}

function spawnDelay(rnd, round) {
  const base = CONFIG.spawn.interval * spawnMul(round);
  const j = CONFIG.spawn.intervalJitter;
  return Math.max(CONFIG.spawn.minInterval, base * (1 + (rnd() * 2 - 1) * j)) / 1000;
}

/* =========================================================================
   Tek run.  opts: { mode:"fixed", acc } | { mode:"quality", skill, threshold }
   ========================================================================= */
function simulateRun(opts, seed) {
  const rnd = mulberry32(seed);
  const dt = SIM.dt;
  const cost = missCost();

  let t = 0, round = 1, runScore = 0;
  let ammo = Math.max(1, Math.round(CONFIG.ammo.poolSize));
  let shots = 0, hits = 0, escaped = 0, escapedUnshot = 0;
  let peakCombo = 1, comboSum = 0, pSum = 0, holdTime = 0, playTime = 0;
  let sinceAnyShot = 0, stalled = false, alive = true;
  const rounds = [], ammoSeries = [];

  while (alive && round <= SIM.maxRounds && t < SIM.maxRunSeconds) {
    const goal = goalFor(round);
    if (CONFIG.ammo.refillEachRound >= 0.5) ammo = Math.max(1, Math.round(CONFIG.ammo.poolSize));
    if (ammo <= 0) { alive = false; break; }

    let combo = 1, sinceShot = 0, roundHits = 0, roundShots = 0, roundScore = 0;
    let roundT = 0, cooldown = 0, spawnTimer = CONFIG.spawn.firstDelay / 1000;
    const ammoStart = ammo;
    const ducks = [];
    let roundOver = false, cleared = false;

    while (!roundOver && t < SIM.maxRunSeconds) {
      t += dt; roundT += dt; sinceShot += dt; cooldown -= dt;
      sinceAnyShot += dt; playTime += dt;
      if (ammoSeries.length < Math.floor(t)) ammoSeries.push([Math.floor(t), ammo]);

      if (combo > 1 && sinceShot >= CONFIG.combo.decayTime) {
        combo = Math.max(1, combo - CONFIG.combo.step);
        sinceShot = 0;
      }

      spawnTimer -= dt;
      if (spawnTimer <= 0 && ducks.length < Math.round(CONFIG.spawn.maxAlive)) {
        ducks.push(makeDuck(rnd, round));
        spawnTimer = spawnDelay(rnd, round);
      }

      for (let i = ducks.length - 1; i >= 0; i--) {
        if (stepDuck(ducks[i], dt)) {
          escaped++;
          if (!ducks[i].shotAt) escapedUnshot++;
          ducks.splice(i, 1);
        }
      }

      if (cooldown <= 0) {
        let target = -1, targetP = 0, candidates = 0;
        if (opts.mode === "fixed") {
          let oldest = -1;
          for (let i = 0; i < ducks.length; i++) {
            if (!shootable(ducks[i])) continue;
            candidates++;
            if (ducks[i].age > oldest) { oldest = ducks[i].age; target = i; }
          }
          targetP = opts.acc;
        } else {
          let best = -1;
          for (let i = 0; i < ducks.length; i++) {
            if (!shootable(ducks[i])) continue;
            candidates++;
            const p = hitChance(ducks[i], opts.skill);
            if (p > best) { best = p; target = i; }
          }
          targetP = best;
          if (target >= 0 && best < opts.threshold) { target = -1; holdTime += dt; }  // atışı atla
        }

        if (target >= 0) {
          cooldown = SIM.shotInterval;
          sinceShot = 0; sinceAnyShot = 0;
          ducks[target].shotAt = true;
          ammo -= 1; shots++; roundShots++; pSum += targetP;
          if (rnd() < targetP) {
            ammo += CONFIG.ammo.refundOnHit;
            hits++; roundHits++;
            const gain = Math.round(CONFIG.score.perDuck * combo);
            roundScore += gain; runScore += gain;
            comboSum += combo;
            combo = Math.min(CONFIG.combo.max, combo + CONFIG.combo.step);
            if (combo > peakCombo) peakCombo = combo;
            ducks.splice(target, 1);
          } else {
            ammo -= (cost - 1);
            combo = 1;
          }
          if (roundHits >= goal) { roundOver = true; cleared = true; }
          else if (ammo <= 0) { roundOver = true; alive = false; }
        } else if (candidates === 0 && opts.mode === "quality") {
          /* ördek yok — bekleme sayılmaz */
        }
      }

      if (sinceAnyShot >= SIM.stallSeconds) { roundOver = true; alive = false; stalled = true; }
    }

    rounds.push({ round, goal, cleared, roundT, roundShots, roundHits, roundScore, ammoStart, ammoEnd: ammo });
    if (!alive) break;
    round++;
  }

  return {
    duration: t, roundReached: round, roundsCleared: rounds.filter(r => r.cleared).length,
    score: runScore, shots, hits, misses: shots - hits, escaped, escapedUnshot,
    peakCombo, avgCombo: hits ? comboSum / hits : 1, avgShotP: shots ? pSum / shots : 0,
    holdShare: playTime ? holdTime / playTime : 0, stalled, rounds, ammoSeries
  };
}

function batch(opts, n, seedBase) {
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(simulateRun(opts, seedBase + i * 7919));
  const scores = runs.map(r => r.score);
  return {
    runs,
    score: mean(scores), scoreSE: se(scores), scoreMed: pct(sorted(scores), 0.5),
    dur: mean(runs.map(r => r.duration)), durMed: pct(sorted(runs.map(r => r.duration)), 0.5),
    rounds: mean(runs.map(r => r.roundsCleared)),
    shots: mean(runs.map(r => r.shots)),
    acc: mean(runs.map(r => r.hits / Math.max(1, r.shots))),
    escapedUnshot: mean(runs.map(r => r.escapedUnshot)),
    hold: mean(runs.map(r => r.holdShare)),
    avgP: mean(runs.map(r => r.avgShotP)),
    combo: mean(runs.map(r => r.avgCombo)),
    peak: mean(runs.map(r => r.peakCombo)),
    stall: runs.filter(r => r.stalled).length / runs.length
  };
}

/* ========================== rapor ========================== */
const line = (n = 78) => "─".repeat(n);

function header() {
  const C = CONFIG;
  console.log("\n" + "═".repeat(78));
  console.log("DUCK PROTO — DENGE SİMÜLASYONU");
  console.log("═".repeat(78));
  console.log("config: " + path.basename(CONFIG_FILE) +
    "  ·  havuz " + C.ammo.poolSize + "  ·  isabet −1/+" + C.ammo.refundOnHit +
    " (net " + (1 - C.ammo.refundOnHit === 0 ? "0" : -(1 - C.ammo.refundOnHit)) + ")" +
    "  ·  ıska −" + missCost());
  console.log("hedef " + C.round.goal + " (+" + C.round.goalGrowth + "/tur)  ·  kombo +" + C.combo.step +
    " / max x" + C.combo.max + " / " + C.combo.decayTime + "sn'de bir kademe düşer  ·  ördek puanı " + C.score.perDuck);
  console.log("zorluk/tur: hız +" + Math.round(C.difficulty.speedGrowth * 100) + "%  spawn −" +
    Math.round(C.difficulty.spawnGrowth * 100) + "%  boyut −" + Math.round(C.difficulty.sizeShrink * 100) +
    "%  ·  tasarım hedefi: run 5–8 dk");

  console.log("\nTuru geçmek için gereken isabet oranı (ve harcanabilir ıska sayısı)");
  let l1 = "", l2 = "";
  for (let r = 1; r <= 10; r++) {
    l1 += padr("T" + r, 7);
    l2 += padr(Math.round(neededAcc(r) * 100) + "% /" + maxMissesFor(r), 7);
  }
  console.log("  " + l1 + "\n  " + l2);
}

function sectionFixed() {
  console.log("\n" + "═".repeat(78));
  console.log("BÖLÜM A — SABİT İSABET MODELİ (eski)   " + RUNS + " run/oran");
  console.log("═".repeat(78));
  console.log("  isabet  süre(ort/med)   tur    skor(ort/med)      ıska%  kaçan  kombo(ort/zirve)");
  const out = [];
  for (const acc of ACCS) {
    const b = batch({ mode: "fixed", acc }, RUNS, SEED0 * 1000003 + Math.round(acc * 1000));
    out.push({ acc, b });
    console.log("  " + padr("%" + Math.round(acc * 100), 8) +
      padr(mmss(b.dur) + " / " + mmss(b.durMed), 16) +
      padr(b.rounds.toFixed(1), 7) +
      padr(Math.round(b.score) + " / " + b.scoreMed, 19) +
      padr("%" + Math.round((1 - b.acc) * 100), 7) +
      padr(b.escapedUnshot.toFixed(1), 7) +
      "x" + b.combo.toFixed(2) + " / x" + b.peak.toFixed(2));
  }
  if (VERBOSE) {
    for (const { acc, b } of out) {
      console.log("\n  %" + Math.round(acc * 100) + " — tur tur (o tura ulaşanların ortalaması)");
      console.log("   tur hedef ulaşan%  süre   atış isabet  ıska  mermi(baş→son)  tur skoru");
      const maxR = Math.max(...b.runs.map(r => r.rounds.length));
      for (let i = 0; i < Math.min(maxR, 10); i++) {
        const rs = b.runs.map(r => r.rounds[i]).filter(Boolean);
        if (!rs.length) break;
        console.log("   " + pad(i + 1, 3) + pad(rs[0].goal, 6) +
          pad(Math.round(100 * rs.length / b.runs.length) + "%", 8) +
          pad(mean(rs.map(r => r.roundT)).toFixed(1) + "s", 7) +
          pad(mean(rs.map(r => r.roundShots)).toFixed(1), 7) +
          pad(mean(rs.map(r => r.roundHits)).toFixed(1), 7) +
          pad(mean(rs.map(r => r.roundShots - r.roundHits)).toFixed(1), 6) +
          pad(mean(rs.map(r => r.ammoStart)).toFixed(1) + "→" + mean(rs.map(r => r.ammoEnd)).toFixed(1), 16) +
          pad(Math.round(mean(rs.map(r => r.roundScore))), 11));
      }
    }
  }
  return out;
}

function qualityTable() {
  console.log("\n" + "═".repeat(78));
  console.log("BÖLÜM B — ATIŞ KALİTESİ MODELİ (yeni)");
  console.log("═".repeat(78));
  const q = SIM.quality;
  console.log("p = beceri × ölçek^" + q.sizeExp + " × (temel hız/hız)^" + q.speedExp +
    " × (1 − " + q.centerPenalty + "·merkez uzaklığı)");
  console.log("beceri: " + SIM.skills.map(s => s.name + " " + s.skill).join("  ·  ") +
    "   |   eşik altındaki atış atlanır (ateş edilmez, kombo işlemeye devam eder)");

  // örnek p değerleri
  console.log("\n  örnek p değerleri (merkezdeki / kenardaki ördek, temel hızda)");
  console.log("   tur  ölçek   " + SIM.skills.map(s => padr(s.name, 15)).join(""));
  for (const r of [1, 3, 5, 8, 12]) {
    const s = sizeMul(r);
    const fake = { scale: s, speed: CONFIG.duck.speed * speedMul(r), x: PLAY_CX, y: PLAY_CY };
    const edge = { scale: s, speed: CONFIG.duck.speed * speedMul(r), x: 20, y: SIM.screenH - 40 };
    let row = "   " + pad(r, 3) + pad(s.toFixed(2), 7) + "   ";
    for (const sk of SIM.skills) {
      row += padr(hitChance(fake, sk.skill).toFixed(2) + " / " + hitChance(edge, sk.skill).toFixed(2), 15);
    }
    console.log(row);
  }
}

function sweep() {
  const results = [];
  for (const sk of SIM.skills) {
    console.log("\n" + line());
    console.log("BECERİ: " + sk.name.toUpperCase() + " (" + sk.skill + ")   eşik taraması — " + SWEEP_RUNS + " run/eşik");
    console.log(line());
    console.log("  eşik   atış  gerçekleşen  ıska%  bekleme%  vurulmadan  tur   süre    skor ± SE");
    console.log("         sayı  isabet p                      kaçan");
    const rows = [];
    for (let th = SIM.sweep.from; th <= SIM.sweep.to + 1e-9; th += SIM.sweep.step) {
      const thr = Math.round(th * 100) / 100;
      // her eşik aynı tohum kümesini kullanır → satırlar arası fark gürültüden arınır
      const b = batch({ mode: "quality", skill: sk.skill, threshold: thr }, SWEEP_RUNS,
                      SEED0 * 7 + Math.round(sk.skill * 1000) * 131);
      rows.push({ thr, b });
    }
    const best = rows.reduce((a, r) => r.b.score > a.b.score ? r : a, rows[0]);
    const bestRounds = rows.reduce((a, r) => r.b.rounds > a.b.rounds ? r : a, rows[0]);
    const clean = rows.filter(r => r.b.stall < 0.05)
                      .reduce((a, r) => (!a || r.b.score > a.b.score) ? r : a, null) || rows[0];
    const maxScore = Math.max(...rows.map(r => r.b.score));
    for (const { thr, b } of rows) {
      const mark = thr === best.thr ? " ◀ en yüksek skor" : (thr === bestRounds.thr ? " ◀ en çok tur" : "");
      console.log("  " + padr(thr.toFixed(2), 7) +
        padr(b.shots.toFixed(0), 6) +
        padr(b.avgP.toFixed(2), 13) +
        padr("%" + Math.round((1 - b.acc) * 100), 7) +
        padr("%" + Math.round(b.hold * 100), 10) +
        padr(b.escapedUnshot.toFixed(1), 12) +
        padr(b.rounds.toFixed(1), 6) +
        padr(mmss(b.dur), 8) +
        padr(Math.round(b.score) + " ±" + Math.round(b.scoreSE), 13) +
        (b.stall > 0.01 ? " tıkanma %" + Math.round(b.stall * 100) : "") + mark +
        "  " + bar(b.score, maxScore, 12));
    }
    results.push({ sk, rows, best, bestRounds, clean });
  }
  return results;
}

function verdict(results, fixedOut) {
  console.log("\n" + "═".repeat(78));
  console.log("BÖLÜM C — CEVAP: OPTİMAL EŞİK 0'DAN BÜYÜK MÜ?");
  console.log("═".repeat(78));
  for (const { sk, rows, best, clean } of results) {
    const zero = rows[0];
    const diff = best.b.score - zero.b.score;
    const combinedSE = Math.sqrt(best.b.scoreSE ** 2 + zero.b.scoreSE ** 2);
    const significant = Math.abs(diff) > 2 * combinedSE;
    console.log("\n  " + sk.name.toUpperCase() + " beceri (" + sk.skill + ")");
    console.log("    optimal eşik      : " + best.thr.toFixed(2) +
      (best.thr === 0 ? "   → HER ZAMAN ATEŞ ET" : "   → eşiğin altını atla"));
    console.log("    skor eşik 0       : " + Math.round(zero.b.score) + " ±" + Math.round(zero.b.scoreSE));
    console.log("    skor optimumda    : " + Math.round(best.b.score) + " ±" + Math.round(best.b.scoreSE) +
      "   (fark " + (diff >= 0 ? "+" : "") + Math.round(diff) + ", %" + Math.round(100 * diff / Math.max(1, zero.b.score)) + ")");
    console.log("    istatistiksel     : " + (significant ? "anlamlı (fark > 2·SE)" : "GÜRÜLTÜ (fark ≤ 2·SE) — eşik fark yaratmıyor"));
    const cd = clean.b.score - zero.b.score;
    const cSE = Math.sqrt(clean.b.scoreSE ** 2 + zero.b.scoreSE ** 2);
    console.log("    tıkanmasız optimum: " + clean.thr.toFixed(2) + "   skor " + Math.round(clean.b.score) +
      " ±" + Math.round(clean.b.scoreSE) + "  (eşik 0'a göre " + (cd >= 0 ? "+" : "") + Math.round(cd) +
      ", " + (Math.abs(cd) > 2 * cSE ? "anlamlı" : "gürültü") + ")   ← tıkanma artefaktından arınmış");
    console.log("    optimumda bekleme : %" + Math.round(best.b.hold * 100) +
      "  ·  vurulmadan kaçan " + best.b.escapedUnshot.toFixed(1) +
      "  ·  ıska %" + Math.round((1 - best.b.acc) * 100) +
      "  ·  süre " + mmss(best.b.dur));
  }

  console.log("\n" + line());
  console.log("YAN YANA — sabit isabet modeli vs. kalite modeli (optimum eşikte)");
  console.log(line());
  console.log("  model                       süre    tur   skor       ıska%  kombo  bekleme%");
  for (const { acc, b } of fixedOut) {
    console.log("  " + padr("sabit isabet %" + Math.round(acc * 100), 27) +
      padr(mmss(b.dur), 8) + padr(b.rounds.toFixed(1), 6) +
      padr(Math.round(b.score), 11) + padr("%" + Math.round((1 - b.acc) * 100), 7) +
      padr("x" + b.combo.toFixed(2), 7) + "—");
  }
  for (const { sk, best, rows } of results) {
    const z = rows[0].b;
    console.log("  " + padr("kalite " + sk.name + " (eşik 0)", 27) +
      padr(mmss(z.dur), 8) + padr(z.rounds.toFixed(1), 6) +
      padr(Math.round(z.score), 11) + padr("%" + Math.round((1 - z.acc) * 100), 7) +
      padr("x" + z.combo.toFixed(2), 7) + "%0");
    console.log("  " + padr("kalite " + sk.name + " (eşik " + best.thr.toFixed(2) + ")", 27) +
      padr(mmss(best.b.dur), 8) + padr(best.b.rounds.toFixed(1), 6) +
      padr(Math.round(best.b.score), 11) + padr("%" + Math.round((1 - best.b.acc) * 100), 7) +
      padr("x" + best.b.combo.toFixed(2), 7) + "%" + Math.round(best.b.hold * 100));
  }

  console.log("\n  tasarım hedefi 5–8 dk:");
  for (const { sk, best } of results) {
    const inRange = best.b.dur >= 300 && best.b.dur <= 480;
    console.log("    kalite " + padr(sk.name, 8) + " optimumda " + mmss(best.b.dur) +
      (inRange ? "  ✓ hedefte" : "  ✗ hedef dışı"));
  }
  console.log("\n" + "═".repeat(78) + "\n");
}

header();
qualityTable();
const fixedOut = sectionFixed();
const results = sweep();
verdict(results, fixedOut);
