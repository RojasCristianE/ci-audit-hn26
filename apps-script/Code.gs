/**
 * ci-audit — Panel de evaluación (backend · Google Apps Script)
 * =============================================================
 * Programa de Incubación de Startups de Base Tecnológica
 * Hackathon Nicaragua 2026 — Centro de Innovación INATEC
 *
 * Web App que recibe el POST JSON del scanner (ci_audit.cjs), valida la
 * estructura, comprueba el código de acceso (si está configurado), evita
 * duplicados idénticos y escribe una fila por envío en la pestaña
 * "Resultados" de la planilla a la que este script está vinculado.
 *
 * Sin API key: la URL /exec con su script id es el acceso de facto, y la
 * protección real está en la validación server-side. El script corre como
 * el dueño (executeAs = USER_DEPLOYING) con acceso de SOLO LECTURA-ESCRITURA
 * sobre la planilla a la que está vinculado (scope spreadsheets.currentonly),
 * es decir, oauthScopes NO abre acceso a otros documentos del dueño.
 *
 * ── Pestañas que crea automáticamente ─────────────────────────────────────
 *   Resultados : una fila por envío (cabecera + 26 columnas).
 *   Setup      : configuración del panel.
 *                  require_code | true/false  (false = modo abierto)
 *                  team_codes   | codigo1,codigo2 (lista de códigos válidos)
 *                Con require_code=true y códigos cargados, los envíos con
 *                team_code desconocido o vacío se rechazan.
 *
 * ── Deploy (una sola vez) ─────────────────────────────────────────────────
 *   1. Abrir la planilla del panel → Extensiones → Apps Script.
 *   2. Pegar este archivo (Code.gs) y appsscript.json.
 *   3. Implementar > Nueva implementación > Aplicación web:
 *        - Ejecutar como:       Yo (el dueño)
 *        - Quién tiene acceso:  Cualquier persona  (permite POST anónimo del CLI)
 *   4. Copiar la URL /exec y configurarla en el scanner:
 *        CI_AUDIT_ENDPOINT=https://script.google.com/macros/s/XXXX/exec node ci_audit.cjs
 *   5. Para cambios futuros de código: "Implementar > Administrar
 *      implementaciones > Editar > Nueva versión" conserva la MISMA URL.
 */
"use strict";

const SHEET_RESULTADOS = "Resultados";
const SHEET_SETUP = "Setup";

// Columnas de la pestaña Resultados (índice = posición en el arreglo + 1).
const HEADERS = [
  "recibido_en",        //  1
  "version_scanner",    //  2
  "codigo_equipo",      //  3
  "equipo",             //  4
  "proyecto",           //  5
  "repo_url",           //  6
  "demo_url",           //  7
  "integrantes",        //  8
  "tier",               //  9
  "score_composite",    // 10
  "puntos",             // 11
  "max_puntos",         // 12
  "lenguaje_principal", // 13
  "frameworks",         // 14
  "rep",                // 15
  "git",                // 16
  "testing",            // 17
  "cicd",               // 18
  "documentacion",      // 19
  "seguridad",          // 20
  "estructura",         // 21
  "deploy",             // 22
  "calidad",            // 23
  "dependencias",       // 24
  "detalle_json",       // 25
  "payload_digest",     // 26
];

// Métricas que el scanner envía en scores (orden de las columnas 15-24).
const METRIC_KEYS = [
  "repo_exists",
  "git_maturity",
  "testing",
  "cicd",
  "documentation",
  "security",
  "structure",
  "deploy_evidence",
  "code_quality",
  "dependencies",
];

const DIGEST_COL = HEADERS.indexOf("payload_digest") + 1; // 26
const MAX_BODY_BYTES = 250 * 1024;
const MAX_DUP_SCAN_ROWS = 200;

// ── Punto de entrada ─────────────────────────────────────────────────────────
/** POST del scanner: valida, deduplica y registra el resultado. */
function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || "";
    if (!raw) return json_({ ok: false, error: "Cuerpo vacío: enviá el JSON del scanner." });
    if (raw.length > MAX_BODY_BYTES) {
      return json_({ ok: false, error: "Payload demasiado grande (" + raw.length + " bytes)." });
    }

    let p;
    try {
      p = JSON.parse(raw);
    } catch (err) {
      return json_({ ok: false, error: "Payload no es JSON válido: " + err.message });
    }

    const vError = validate_(p);
    if (vError) return json_({ ok: false, error: vError });

    ensureSheets_();

    const digest = digest_(p);
    if (isDuplicate_(digest)) {
      return json_({
        ok: false,
        error:
          "Este resultado ya fue registrado (mismo contenido). " +
          "Si mejoraste el proyecto, volvé a ejecutar el scanner después de los cambios.",
      });
    }

    const row = buildRow_(p, digest);
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESULTADOS).appendRow(row);

    return json_({
      ok: true,
      message: "Resultado registrado en el panel.",
      recibido_en: new Date().toISOString(),
      team: p.team && p.team.team_name ? String(p.team.team_name) : "",
    });
  } catch (err) {
    console.error("doPost error: " + err);
    return json_({ ok: false, error: "Error interno del panel: " + String(err) });
  }
}

/** GET: sanity check o lectura en formato JSON (?format=json). */
function doGet(e) {
  let count = 0;
  let last = null;
  let rows = [];
  try {
    ensureSheets_();
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESULTADOS);
    count = Math.max(0, sh.getLastRow() - 1);
    if (count > 0) {
      const allData = sh.getDataRange().getValues();
      const headers = allData[0];
      for (let i = 1; i < allData.length; i++) {
        const rowObj = {};
        for (let j = 0; j < headers.length; j++) {
          rowObj[headers[j]] = allData[i][j];
        }
        rows.push(rowObj);
      }
      const r = sh.getRange(count + 1, 4, 1, 2).getValues()[0]; // equipo, proyecto
      last = { equipo: r[0], proyecto: r[1] };
    }
  } catch (err) {
    // El GET no debe romper por un problema menor de la planilla.
  }

  if (e && e.parameter && e.parameter.format === "json") {
    return json_({ ok: true, count: count, rows: rows });
  }

  const html =
    "<h2>🧠 ci-audit · panel</h2>" +
    "<p>Web App operativa — " + count + " resultado(s) registrado(s)" +
    (last && last.equipo ? " · último: <b>" + last.equipo + "</b>" : "") + ".</p>" +
    "<p><small>Este endpoint acepta POST JSON del scanner. Usá ?format=json para consultar el listado.</small></p>";
  return HtmlService.createHtmlOutput(html);
}

// ── Validación ───────────────────────────────────────────────────────────────
/** Devuelve un string con el error, o null si el payload es aceptable. */
function validate_(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "Payload inválido (objeto esperado).";
  if (typeof p.version !== "string") return "Falta el campo version (string).";
  if (!p.team || typeof p.team !== "object") return "Falta team (objeto).";
  if (typeof p.team.team_name !== "string" || !p.team.team_name.trim()) {
    return "Falta team.team_name (string no vacío).";
  }
  if (typeof p.team.project_name !== "string" || !p.team.project_name.trim()) {
    return "Falta team.project_name (string no vacío).";
  }
  if (!Array.isArray(p.team.members) || p.team.members.length === 0) {
    return "Falta team.members (debe registrar al menos 1 integrante).";
  }
  for (const m of p.team.members) {
    if (!m || typeof m.name !== "string" || !m.name.trim()) {
      return "Cada integrante en team.members debe incluir un nombre no vacío.";
    }
  }
  if (!p.scores || typeof p.scores !== "object" || Array.isArray(p.scores)) {
    return "Falta scores (objeto con las 10 métricas).";
  }
  for (const k of METRIC_KEYS) {
    const s = p.scores[k];
    if (!s || typeof s.raw !== "number" || s.raw < 0 || s.raw > 10) {
      return "Métrica inválida en scores." + k + " (raw debe ser número 0-10).";
    }
  }
  if (typeof p.composite_score !== "number" || p.composite_score < 0 || p.composite_score > 100) {
    return "Falta composite_score (número 0-100).";
  }

  // Código de acceso (anti-spam opcional, configurado en la pestaña Setup).
  const cfg = loadConfig_();
  if (cfg.require_code) {
    const code = String((p.team && p.team.team_code) || "").trim().toLowerCase();
    if (!code || cfg.team_codes.indexOf(code) === -1) {
      return "Código de acceso no válido. Revisá el código del programa con el equipo organizador.";
    }
  }
  return null;
}

// ── Construcción de la fila ───────────────────────────────────────────────────
function buildRow_(p, digest) {
  const t = p.team || {};
  const raw = (k) => {
    const s = p.scores[k];
    return s && typeof s.raw === "number" ? s.raw : "";
  };
  const membersStr = (t.members || [])
    .map((m) => (m && m.name ? m.name + (m.role ? " (" + m.role + ")" : "") : ""))
    .filter(Boolean)
    .join("; ");

  return [
    new Date().toISOString(),     // recibido_en
    p.version,                    // version_scanner
    String(t.team_code || ""),    // codigo_equipo
    t.team_name,                  // equipo
    t.project_name || "",         // proyecto
    t.repo_url || "",             // repo_url
    t.demo_url || "",             // demo_url
    membersStr,                   // integrantes
    p.tier || "",                 // tier
    p.composite_score,            // score_composite
    p.total_points || 0,          // puntos
    p.max_points || 0,            // max_puntos
    (p.stack && p.stack.primary_language) || "",
    (p.stack && p.stack.frameworks_detected) ? p.stack.frameworks_detected.join(", ") : "",
    raw("repo_exists"),           // rep
    raw("git_maturity"),          // git
    raw("testing"),               // testing
    raw("cicd"),                  // cicd
    raw("documentation"),         // documentacion
    raw("security"),              // seguridad
    raw("structure"),             // estructura
    raw("deploy_evidence"),       // deploy
    raw("code_quality"),          // calidad
    raw("dependencies"),          // dependencias
    JSON.stringify(p.details || {}), // detalle_json
    digest,                       // payload_digest
  ];
}

// ── Dedupe ─────────────────────────────────────────────────────────────────────
/** Hash SHA-1 del contenido sustancial (sin timestamp/cwd → ignorar re-envíos). */
function digest_(p) {
  const stable = JSON.stringify({
    team: p.team.team_name,
    scores: p.scores,
    stack: p.stack ? p.stack.primary_language : null,
  });
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    stable,
    Utilities.Charset.UTF_8
  );
  return bytes.map((b) => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");
}

/** ¿El digest ya está en las últimas MAX_DUP_SCAN_ROWS filas? */
function isDuplicate_(digest) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESULTADOS);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return false;
  const first = Math.max(2, lastRow - MAX_DUP_SCAN_ROWS + 1);
  const values = sh.getRange(first, DIGEST_COL, lastRow - first + 1, 1).getValues();
  return values.some((row) => String(row[0]) === digest);
}

// ── Configuración (pestaña Setup) ──────────────────────────────────────────────
/** Lee la configuración; si falta la pestaña, asume modo abierto. */
function loadConfig_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETUP);
  if (!sh) return { require_code: false, team_codes: [] };
  const map = {};
  const values = sh.getDataRange().getValues();
  for (const r of values) {
    if (r[0] !== "" && r[0] !== null && r[0] !== undefined && r[1] !== undefined) {
      map[String(r[0]).trim().toLowerCase()] = String(r[1]).trim();
    }
  }
  const codes = String(map.team_codes || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    require_code: String(map.require_code || "").toLowerCase() === "true",
    team_codes: codes,
  };
}

// ── Inicialización de pestañas ────────────────────────────────────────────────
/** Crea Resultados y Setup (con defaults) si no existen. Idempotente. */
function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let res = ss.getSheetByName(SHEET_RESULTADOS);
  if (!res) {
    res = ss.insertSheet(SHEET_RESULTADOS);
    res.appendRow(HEADERS);
    res.setFrozenRows(1);
  } else if (res.getLastRow() === 0) {
    res.appendRow(HEADERS);
    res.setFrozenRows(1);
  }

  let setup = ss.getSheetByName(SHEET_SETUP);
  if (!setup) {
    setup = ss.insertSheet(SHEET_SETUP);
    setup.appendRow(["param", "value"]);
    setup.appendRow(["require_code", "false"]);
    setup.appendRow(["team_codes", ""]);
    setup.getRange("A5").setValue("true/false — con true se exige código válido en team_code.");
    setup.getRange("A6").setValue("Lista separada por comas de códigos habilitados (en Setup > team_codes).");
  }
}

// ── Helper de respuesta ────────────────────────────────────────────────────────
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}