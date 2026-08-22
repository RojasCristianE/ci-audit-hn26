#!/usr/bin/env node
/**
 * merge.js — Score final y tier list por equipo (nivel cohorte)
 * ============================================================
 * Método (pesos relativos):
 *
 *   1. El scanner emite puntos por métrica (raw 0-10 × peso relativo).
 *   2. A nivel cohorte se DESCARTAN las métricas donde todos los equipos
 *      obtuvieron 0 (si nadie lo hace, no penaliza a nadie).
 *   3. Se normaliza: nota perfecta en las categorías activas = 100,
 *      la mitad de los puntos posibles = 50 (escala relativa).
 *   4. Score final = scanner_normalizado × 0.6 + rúbrica × 0.4
 *      (la rúbrica es opcional: sin datos del mentor, el scanner vale 100%).
 *   5. Tier: A (≥65) · B (45-64) · C (<45) sobre el score final.
 *
 * Uso:
 *   node merge.js --results <dir|json> [--mentor data/mentor_observations.json]
 *                 [--out tier-list.json]
 *
 *   --results: directorio de ci-audit-result.json (uno por equipo) o un único JSON.
 *   --mentor:  data/mentor_observations.json (estructura {teams: {id: {team_name, normalized_score}}}).
 *   --out:     archivo de salida (default: tier-list.json en el directorio actual).
 */
"use strict";

const fs = require("fs");
const path = require("path");

// ── Configuración (mantener en sync con ci_audit.cjs) ────────────────────────
const METRICS = {
  repo_exists: 5,
  git_maturity: 20,
  testing: 15,
  cicd: 15,
  documentation: 10,
  security: 5,
  structure: 10,
  deploy_evidence: 10,
  code_quality: 5,
  dependencies: 5,
};
const TIER_A_MIN = 65;
const TIER_B_MIN = 45;
const SCANNER_WEIGHT = 0.6;
const RUBRIC_WEIGHT = 0.4;

// ── Helpers ───────────────────────────────────────────────────────────────────
function pyRound(x, ndigits) {
  const m = Math.pow(10, ndigits);
  const scaled = x * m;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r;
  if (diff < 0.5) r = floor;
  else if (diff > 0.5) r = floor + 1;
  else r = floor % 2 === 0 ? floor : floor + 1;
  return r / m;
}

function argValue(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

function teamId(payload, file) {
  const t = payload.team || {};
  return (t.team_name || t.project_name || path.basename(file, ".json")).toString();
}

function loadResults(resultsArg) {
  const p = path.resolve(resultsArg);
  if (!fs.existsSync(p)) {
    console.error(`✗ No existe: ${resultsArg}`);
    process.exit(1);
  }
  const files = [];
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p).sort()) {
      if (f.endsWith(".json")) files.push(path.join(p, f));
    }
  } else {
    files.push(p);
  }

  const teams = [];
  for (const f of files) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      console.warn(`  ⚠ ${f}: JSON inválido — omitido (${e.message})`);
      continue;
    }
    if (!payload.scores) {
      console.warn(`  ⚠ ${f}: sin campo scores — omitido`);
      continue;
    }
    const raw = {};
    let hasAny = false;
    for (const [metric, weight] of Object.entries(METRICS)) {
      const s = payload.scores[metric] || {};
      raw[metric] = typeof s.raw === "number" ? s.raw : 0;
      if (raw[metric] > 0) hasAny = true;
    }
    if (!hasAny) console.warn(`  ⚠ ${f}: todas las métricas en 0 — igual se incluye`);
    teams.push({ id: teamId(payload, f), file: path.basename(f), raw });
  }
  if (teams.length === 0) {
    console.error("✗ No se cargaron resultados de scanner.");
    process.exit(1);
  }
  return teams;
}

function loadRubric(mentorFile) {
  if (!mentorFile) return null;
  const data = JSON.parse(fs.readFileSync(mentorFile, "utf8"));
  const byName = {};
  for (const [tid, entry] of Object.entries(data.teams || {})) {
    const name = (entry.team_name || tid).toString().toLowerCase();
    if (typeof entry.normalized_score === "number") byName[name] = entry.normalized_score;
  }
  return byName;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const resultsArg = argValue(args, "--results", null);
const mentorArg = argValue(args, "--mentor", null);
const outArg = argValue(args, "--out", path.join(process.cwd(), "tier-list.json"));

if (!resultsArg) {
  console.error("Uso: node merge.js --results <dir|json> [--mentor data/mentor_observations.json] [--out tier-list.json]");
  process.exit(1);
}

const teams = loadResults(resultsArg);
const rubric = loadRubric(mentorArg);

// 1. Categorías activas: al menos un equipo con raw > 0
const allMetrics = Object.keys(METRICS);
const active = allMetrics.filter((m) => teams.some((t) => t.raw[m] > 0));
const discarded = allMetrics.filter((m) => !active.includes(m));

// 2. Máximo posible con las categorías activas
const maxPoints = active.reduce((acc, m) => acc + METRICS[m] * 10, 0);

// 3. Normalizar cada equipo: puntos / max_posible × 100
for (const t of teams) {
  const points = active.reduce((acc, m) => acc + t.raw[m] * METRICS[m], 0);
  t.points = points;
  t.scanner_norm = maxPoints > 0 ? pyRound((points / maxPoints) * 100, 1) : 0;
}

// 4. Combinar con la rúbrica (60/40) y asignar tier
for (const t of teams) {
  const r = rubric ? rubric[t.id.toLowerCase()] : undefined;
  t.rubric_norm = typeof r === "number" ? r : null;
  t.final = t.rubric_norm !== null
    ? pyRound(t.scanner_norm * SCANNER_WEIGHT + t.rubric_norm * RUBRIC_WEIGHT, 1)
    : t.scanner_norm;
  t.tier = t.final >= TIER_A_MIN ? "A" : t.final >= TIER_B_MIN ? "B" : "C";
}

teams.sort((a, b) => b.final - a.final);

// 5. Salida
const result = {
  version: "1.0.0",
  generated_at: new Date().toISOString(),
  formula: {
    scanner_weight: SCANNER_WEIGHT,
    rubric_weight: RUBRIC_WEIGHT,
    normalization: "perfecto en categorías activas = 100",
    discard: "categorías con 0 en todo el cohorte",
  },
  cohort: {
    teams_count: teams.length,
    metrics_active: active,
    metrics_discarded: discarded,
    max_points: maxPoints,
  },
  teams: teams.map((t) => ({
    id: t.id,
    scanner_norm: t.scanner_norm,
    rubric_norm: t.rubric_norm,
    final: t.final,
    tier: t.tier,
  })),
};

const outPath = path.resolve(outArg);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

// Reporte en consola
console.log(`\n── Tier list (cohorte de ${teams.length} equipos) ──`);
console.log(`  Categorías activas: ${active.length}/${allMetrics.length} → ${active.join(", ")}`);
if (discarded.length) {
  console.log(`  Categorías descartadas (0 en todo el cohorte): ${discarded.join(", ")}`);
}
if (maxPoints === 0) console.log("  ⚠ Ninguna categoría activa: todos los scores = 0.");
const counts = { A: 0, B: 0, C: 0 };
for (const t of teams) {
  counts[t.tier]++;
  const r = t.rubric_norm !== null ? ` | rúbrica ${t.rubric_norm}` : " | sin rúbrica";
  console.log(`  ${t.tier}  ${String(t.final).padStart(5)}  ${t.id.padEnd(30)} scanner ${t.scanner_norm}${r}`);
}
console.log(`  Distribución: A=${counts.A} · B=${counts.B} · C=${counts.C}`);
console.log(`\n  Guardado en: ${outPath}`);
