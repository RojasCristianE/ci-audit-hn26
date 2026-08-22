#!/usr/bin/env node
/**
 * ci-audit — CI Nicaragua: Audit de Madurez Técnica para Startups
 * ================================================================
 * Programa de Incubación de Startups de Base Tecnológica
 * Hackathon Nicaragua 2026 — Centro de Innovación INATEC
 *
 * Ejecutar en el directorio raíz del proyecto de la startup:
 *
 *     node ci_audit.cjs
 *
 * También disponible vía npx (desde GitHub):
 *
 *     npx --yes github:RojasCristianE/ci-audit-hn26 ci-audit
 *
 * Zero dependencias. Solo necesita Node.js 18+ y git (opcional).
 *
 * Scanner de 10 métricas objetivas de madurez técnica (0-10 c/u).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const readline = require("readline");

// ── Configuración ──────────────────────────────────────────────────────────────
// CAMBIAR ESTA URL por la del deployment de Google Apps Script
// (Se obtiene al hacer Deploy > Web App en el editor de Apps Script)
// Dejar vacío para modo dry-run (sin envío)
const GOOGLE_APPS_SCRIPT_URL = process.env.CI_AUDIT_ENDPOINT || "";
const VERSION = "1.0.1";
const TIMEOUT_SECONDS = 30;
const CWD = process.cwd();
const NO_COLOR = !!process.env.NO_COLOR || process.platform === "win32";

// Umbrales de tier (sobre el score normalizado 0-100)
const TIER_A_MIN = 65;
const TIER_B_MIN = 45;

// ── Métricas y pesos (suman 1.0) ───────────────────────────────────────────────
// Pesos RELATIVOS: importancia relativa, sin obligación de sumar 1.0.
// El score final se normaliza a nivel cohorte (ver merge.js): se descartan las
// categorías donde TODOS los equipos dieron 0 y perfecto = 100.
const METRICS = {
  repo_exists:     { label: "Repositorio",       weight: 5 },
  git_maturity:    { label: "Git Madurez",       weight: 20 },
  testing:         { label: "Testing",           weight: 15 },
  cicd:            { label: "CI/CD Pipeline",    weight: 15 },
  documentation:   { label: "Documentación",     weight: 10 },
  security:        { label: "Seguridad",         weight: 5 },
  structure:       { label: "Estructura",        weight: 10 },
  deploy_evidence: { label: "Deploy Evidence",   weight: 10 },
  code_quality:    { label: "Calidad de Código", weight: 5 },
  dependencies:    { label: "Dependencias",      weight: 5 },
};
const MAX_POINTS = Object.values(METRICS).reduce((a, m) => a + m.weight, 0) * 10; // 1000

// ── Helpers de color ──────────────────────────────────────────────────────────
const bold   = (t) => (NO_COLOR ? t : `\x1b[1m${t}\x1b[0m`);
const green  = (t) => (NO_COLOR ? t : `\x1b[32m${t}\x1b[0m`);
const red    = (t) => (NO_COLOR ? t : `\x1b[31m${t}\x1b[0m`);
const yellow = (t) => (NO_COLOR ? t : `\x1b[33m${t}\x1b[0m`);

function bar(score) {
  const filled = Math.floor((score / 10) * 10);
  const blocks = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${blocks} ${score}/10`;
}

/** Redondeo half-to-even (IEEE 754), aplicado sobre el float. */
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

// ── Ejecución de comandos ──────────────────────────────────────────────────────
function _run(cmd, cwdOverride) {
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      cwd: cwdOverride || CWD,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024, // git log --all puede superar 1 MB (repos grandes)
    });
    if (r.error || r.status === null) return [-1, "", ""];
    return [r.status, (r.stdout || "").trim(), (r.stderr || "").trim()];
  } catch {
    return [-1, "", ""];
  }
}

function _git_available() {
  return _run(["git", "rev-parse", "--git-dir"])[0] === 0;
}

const EXCLUDE_DIRS = new Set([
  ".git", ".venv", "venv", "node_modules", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".tox", ".eggs",
  "dist", "build", ".next", ".nuxt", ".cache",
  "target", ".gradle", ".idea", ".vscode",
]);

// ── Árbol del proyecto (cacheado) ──────────────────────────────────────────────
let _tree = null;
let _rawTree = null;

function walkTree(raw) {
  const entries = [];
  const stack = [{ rel: [], abs: CWD }];
  while (stack.length) {
    const { rel, abs } = stack.pop();
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      continue;
    }
    names.sort(); // determinista (el orden no afecta los scores)
    for (const name of names) {
      if (!raw && EXCLUDE_DIRS.has(name)) continue; // poda segura: mismos resultados
      const childAbs = path.join(abs, name);
      const childRel = rel.concat(name);
      let lst;
      try {
        lst = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      const isSymlink = lst.isSymbolicLink();
      let isDir = lst.isDirectory();
      let isFile = lst.isFile();
      if (isSymlink) {
        // pathlib no desciende en symlinks a directorios, pero los lista
        try {
          const st = fs.statSync(childAbs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // symlink roto
        }
      }
      entries.push({ rel: childRel, isDir, isFile });
      if (isDir && !isSymlink) stack.push({ rel: childRel, abs: childAbs });
    }
  }
  return entries;
}

function treeEntries() {
  if (!_tree) _tree = walkTree(false);
  return _tree;
}

function rawTreeEntries() {
  // rglob directo (detect_tech_stack) que NO filtra EXCLUDE_DIRS.
  if (!_rawTree) _rawTree = walkTree(true);
  return _rawTree;
}

const SEG_SPECIAL = /[.*+?^${}()|[\]\\]/;

function segMatches(seg, name) {
  let re = "^";
  for (const ch of seg) {
    if (ch === "*") re += "[^/]*";
    else if (SEG_SPECIAL.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(re + "$").test(name);
}

/**
 * Matchea un path contra componentes de patrón glob:
 *  - '**' consume cero o más segmentos que sean DIRECTORIOS (para una
 *    entrada directorio, todos sus segmentos cuentan como dirs).
 *  - '*' (y literales) consumen exactamente un segmento (archivo o dir).
 * El patrón ya viene con la forma '**' + '/' prepended (rglob).
 */
function globMatch(rel, entryIsDir, comps) {
  const n = rel.length;
  function rec(ci, si) {
    if (ci === comps.length) return si === n;
    const c = comps[ci];
    if (c === "**") {
      if (rec(ci + 1, si)) return true;
      let k = si;
      while (k < n && (k < n - 1 || entryIsDir)) {
        k++;
        if (rec(ci + 1, k)) return true;
      }
      return false;
    }
    if (si >= n) return false;
    if (!segMatches(c, rel[si])) return false;
    return rec(ci + 1, si + 1);
  }
  return rec(0, 0);
}

/** Equivalente de rglob(patrones) + filtro EXCLUDE. */
function _files_by_pattern(patterns) {
  const results = [];
  for (const pat of patterns) {
    const comps = ["**"].concat(pat.split("/"));
    for (const e of treeEntries()) {
      if (e.rel.some((s) => EXCLUDE_DIRS.has(s))) continue;
      if (globMatch(e.rel, e.isDir, comps)) results.push(e.rel.join("/"));
    }
  }
  return results;
}

/** rglob directo SIN filtro EXCLUDE (semántica de detect_tech_stack). */
function rglobRaw(patterns) {
  const results = [];
  for (const pat of patterns) {
    const comps = ["**"].concat(pat.split("/"));
    for (const e of rawTreeEntries()) {
      if (globMatch(e.rel, e.isDir, comps)) results.push(e.rel.join("/"));
    }
  }
  return results;
}

// Solo descarta el último vacío (el del salto final)
const SPLIT_RE = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/;
function splitlinesCount(content) {
  if (content === "") return 0;
  const parts = content.split(SPLIT_RE);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/**
 * Decodifica UTF-8 descartando bytes inválidos byte a byte
 * (equivalente a read_text(errors="ignore")).
 */
function decodeUtf8Ignore(buf) {
  let out = "";
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b0 = buf[i];
    let cp;
    let len;
    if (b0 < 0x80) { cp = b0; len = 1; }
    else if (b0 >= 0xc2 && b0 <= 0xdf) { cp = b0 & 0x1f; len = 2; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { cp = b0 & 0x0f; len = 3; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { cp = b0 & 0x07; len = 4; }
    else { i++; continue; } // byte inválido → se descarta

    let ok = true;
    for (let k = 1; k < len; k++) {
      if (i + k >= n) { ok = false; break; }
      const c = buf[i + k];
      if ((c & 0xc0) !== 0x80) { ok = false; break; }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) { i++; continue; } // secuencia incompleta → descarta el primer byte
    // overlong / surrogates / > U+10FFFF
    if (len === 3 && b0 === 0xe0 && (buf[i + 1] & 0xe0) === 0x80) { i++; continue; }
    if (len === 3 && b0 === 0xed && (buf[i + 1] & 0xe0) === 0xa0) { i++; continue; }
    if (len === 4 && b0 === 0xf0 && (buf[i + 1] & 0xf0) === 0x80) { i++; continue; }
    if (len === 4 && b0 === 0xf4 && (buf[i + 1] & 0xf0) >= 0x90) { i++; continue; }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

function readTextIgnore(p) {
  return decodeUtf8Ignore(fs.readFileSync(p));
}

function countLinesInExtensions(extensions) {
  let total = 0;
  for (const ext of extensions) {
    for (const e of treeEntries()) {
      if (!e.isFile) continue;
      if (!e.rel[e.rel.length - 1].endsWith(ext)) continue;
      if (e.rel.some((s) => EXCLUDE_DIRS.has(s))) continue;
      try {
        total += splitlinesCount(readTextIgnore(path.join(CWD, ...e.rel)));
      } catch {
        /* OSError → ignora */
      }
    }
  }
  return total;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── Scanner: 10 métricas (0-10 cada una) ──────────────────────────────────────
function scanRepoExists() {
  const details = { has_git: false, has_remote: false, remote_url: null };
  if (_run(["git", "rev-parse", "--git-dir"])[0] !== 0) return [0, details];

  details.has_git = true;
  const [, stdout] = _run(["git", "remote", "-v"]);
  if (stdout.includes("origin")) {
    details.has_remote = true;
    const m = stdout.match(/origin\s+(\S+)/);
    if (m) details.remote_url = m[1];
  }

  const score = (details.has_git ? 5 : 0) + (details.has_remote ? 5 : 0);
  return [score, details];
}

function scanGitMaturity() {
  if (!_git_available()) {
    return [0, { commits: 0, branches: 0, contributors: 0 }];
  }

  const details = {
    commits: 0, branches: 0, contributors: 0,
    last_commit_days_ago: null, commit_frequency_weekly: 0,
  };

  const [, logOut] = _run(["git", "log", "--oneline", "--all"]);
  const commits = logOut ? logOut.split("\n").length : 0;
  details.commits = commits;

  const [, branchOut] = _run(["git", "branch", "-a"]);
  const branches = branchOut ? branchOut.split("\n").length : 0;
  details.branches = branches;

  const [, shortOut] = _run(["git", "shortlog", "-sn", "--all"]);
  const contributors = shortOut ? shortOut.split("\n").length : 0;
  details.contributors = contributors;

  const [, lastOut] = _run(["git", "log", "-1", "--format=%ct"]);
  let daysAgo = null;
  if (lastOut) {
    const lastTs = parseInt(lastOut, 10);
    daysAgo = (Date.now() / 1000 - lastTs) / 86400;
    details.last_commit_days_ago = pyRound(daysAgo, 1);
  }

  let score = 0;
  if (commits >= 2) score += 2;
  if (commits >= 10) score += 2;
  if (commits >= 30) score += 1;
  if (branches >= 2) score += 2;
  if (branches >= 4) score += 1;
  if (contributors >= 2) score += 2;

  details.commit_frequency_weekly = pyRound(commits / Math.max(1, (daysAgo || 30) / 7), 1);
  return [Math.min(10, score), details];
}

function scanTesting() {
  const testFiles = _files_by_pattern([
    "**/test_*.py", "**/*_test.py", "**/test*.py",
    "**/*.test.js", "**/*.test.ts", "**/*.test.jsx", "**/*.test.tsx",
    "**/*.spec.js", "**/*.spec.ts", "**/*.spec.jsx", "**/*.spec.tsx",
    "**/tests/**", "**/test/**", "**/__tests__/**",
    "**/*Test.java", "**/*Test.kt", "**/*_test.go",
  ]).filter((p) => !p.includes(".git"));

  const frameworks = [];
  const hasPytestIni = fs.existsSync(path.join(CWD, "pytest.ini"));
  const hasPyproject = fs.existsSync(path.join(CWD, "pyproject.toml"));
  if (hasPytestIni || hasPyproject) {
    let content = "";
    try {
      content = readTextIgnore(path.join(CWD, "pyproject.toml"));
    } catch {
      /* OSError → content vacío */
    }
    if (content.includes("pytest") || hasPytestIni) frameworks.push("pytest");
  }
  if (_files_by_pattern(["jest.config.*", ".jest.*"]).length) frameworks.push("jest");
  if (_files_by_pattern(["vitest.config.*"]).length) frameworks.push("vitest");
  if (_files_by_pattern(["karma.conf.*"]).length) frameworks.push("karma");
  if (_files_by_pattern(["build.gradle*"]).length &&
      _files_by_pattern(["**/*.gradle*"]).some((f) => f.toLowerCase().includes("junit"))) {
    frameworks.push("junit");
  }
  frameworks.sort();

  const details = { test_files_count: testFiles.length, frameworks };

  let score = 0;
  if (testFiles.length) score += Math.min(8, testFiles.length);
  if (frameworks.length) score += Math.min(3, frameworks.length);
  return [Math.min(10, score), details];
}

function scanCicd() {
  const details = {};
  const ghActions = _files_by_pattern([".github/workflows/*.yml", ".github/workflows/*.yaml"]);
  details.github_actions = ghActions.length;

  const gitlabCi = path.join(CWD, ".gitlab-ci.yml");
  details.gitlab_ci = fs.existsSync(gitlabCi);

  const dockerfile = path.join(CWD, "Dockerfile");
  const composeYml = path.join(CWD, "docker-compose.yml");
  const composeYaml = path.join(CWD, "docker-compose.yaml");
  details.dockerfile = fs.existsSync(dockerfile);
  details.docker_compose = fs.existsSync(composeYml) || fs.existsSync(composeYaml);

  const makefile = path.join(CWD, "Makefile");
  details.makefile = fs.existsSync(makefile);

  const vercel = path.join(CWD, "vercel.json");
  const netlify = path.join(CWD, "netlify.toml");
  const railway = path.join(CWD, "railway.json");
  details.vercel = fs.existsSync(vercel);
  details.netlify = fs.existsSync(netlify);
  details.railway = fs.existsSync(railway);

  let score = 0;
  if (ghActions.length) score += Math.min(6, ghActions.length * 3);
  if (details.gitlab_ci) score += 3;
  if (details.dockerfile) score += 3;
  if (details.docker_compose) score += 1;
  if (details.makefile || details.vercel || details.netlify || details.railway) score += 1;
  return [Math.min(10, score), details];
}

function scanDocumentation() {
  const details = {
    readme_exists: false, readme_size: 0, has_setup: false,
    docs_dir: false, architecture_docs: false,
  };

  let readme = null;
  for (const name of ["README.md", "Readme.md", "readme.md",
    "README.rst", "README.txt", "README"]) {
    const candidate = path.join(CWD, name);
    if (fs.existsSync(candidate)) {
      readme = candidate;
      break;
    }
  }

  if (readme) {
    details.readme_exists = true;
    try {
      const content = readTextIgnore(readme);
      details.readme_size = Array.from(content).length; // code points
      details.has_setup = [
        "install", "instalación", "setup", "configuración",
        "getting started", "quick start", "quickstart",
      ].some((kw) => content.toLowerCase().includes(kw));
    } catch {
      /* OSError → sin contenido */
    }
  }

  details.docs_dir = isDir(path.join(CWD, "docs"));

  const archFiles = _files_by_pattern([
    "ARCHITECTURE*", "architecture*", "ADR*", "adr*", "DESIGN*",
    "CONTRIBUTING*", "contributing*", "CHANGELOG*", "changelog*",
  ]);
  details.architecture_docs = archFiles.length > 0;

  let score = 0;
  if (details.readme_exists) score += 3;
  if (details.has_setup) score += 3;
  if (details.docs_dir) score += 2;
  if (details.architecture_docs) score += 2;
  return [Math.min(10, score), details];
}

function scanSecurity() {
  const details = {
    hardcoded_secrets: 0, has_env_example: false,
    has_gitignore: false, gitignore_has_env: false,
  };

  const secretPatterns = [
    /(api[_-]?key|apikey|secret|password|passwd|token|auth)\s*[:=]\s*["'][^\s"']{8,}["']/gi,
    /(api[_-]?key|apikey|secret|token)\s*=\s*[^\s]{8,}/gi,
  ];
  const extensions = [".py", ".js", ".ts", ".jsx", ".tsx", ".dart", ".java", ".kt",
    ".go", ".rb", ".php", ".env", ".yaml", ".yml", ".json", ".xml"];
  for (const ext of extensions) {
    for (const e of treeEntries()) {
      if (!e.isFile) continue;
      if (!e.rel[e.rel.length - 1].endsWith(ext)) continue;
      if (e.rel.some((s) => EXCLUDE_DIRS.has(s))) continue;
      let content;
      try {
        content = readTextIgnore(path.join(CWD, ...e.rel));
      } catch {
        continue;
      }
      for (const pat of secretPatterns) {
        const m = content.match(pat);
        details.hardcoded_secrets += m ? m.length : 0;
      }
    }
  }

  for (const name of [".env.example", ".env.sample", ".env.template", ".env.default",
    ".env.production.sample", ".env.development.sample"]) {
    if (fs.existsSync(path.join(CWD, name))) {
      details.has_env_example = true;
      break;
    }
  }

  const gitignore = path.join(CWD, ".gitignore");
  details.has_gitignore = fs.existsSync(gitignore);
  if (details.has_gitignore) {
    try {
      const content = readTextIgnore(gitignore);
      details.gitignore_has_env = content.includes(".env") || content.includes("*.env");
    } catch {
      /* OSError → false */
    }
  }

  // Higiene positiva — arranca en 0 y suma por buenas prácticas
  let score = 0;
  if (details.has_gitignore) score += 5;
  if (details.gitignore_has_env) score += 2;
  if (details.has_env_example) score += 3;
  score -= Math.min(5, details.hardcoded_secrets);
  return [Math.max(0, Math.min(10, score)), details];
}

function scanStructure() {
  const details = {
    has_src: false, has_app: false, has_api: false,
    has_config: false, has_tests: false, has_docs: false,
    modular_count: 0,
  };

  const indicators = {
    has_src: ["src"],
    has_app: ["app", "application"],
    has_api: ["api", "routes", "controllers"],
    has_config: ["config", "settings", "configuration"],
    has_tests: ["tests", "test", "__tests__", "spec"],
    has_docs: ["docs", "documentation"],
  };
  for (const [key, dirs] of Object.entries(indicators)) {
    for (const d of dirs) {
      if (isDir(path.join(CWD, d))) {
        details[key] = true;
        details.modular_count += 1;
        break;
      }
    }
  }

  let score = 0;
  if (details.has_src || details.has_app) score += 4;
  if (details.has_tests) score += 2;
  if (details.has_config) score += 2;
  if (details.has_docs) score += 1;
  if (details.has_api) score += 1;
  return [Math.min(10, score), details];
}

function scanDeployEvidence() {
  const details = {
    build_dir: false, dist_dir: false, out_dir: false,
    hosting_configs: [], has_deploy_script: false,
  };

  for (const d of ["build", "dist", "out", "public", "_site", ".next"]) {
    if (isDir(path.join(CWD, d))) details[`${d}_dir`] = true;
  }

  const hostingFiles = {
    "firebase.json": "Firebase",
    "app.yaml": "Google App Engine",
    "Procfile": "Heroku",
    "netlify.toml": "Netlify",
    "vercel.json": "Vercel",
    "railway.json": "Railway",
    "fly.toml": "Fly.io",
    "render.yaml": "Render",
    "docker-compose.yml": "Docker Compose",
    "docker-compose.yaml": "Docker Compose",
    "Dockerfile": "Docker",
  };
  for (const [filename, service] of Object.entries(hostingFiles)) {
    if (fs.existsSync(path.join(CWD, filename))) details.hosting_configs.push(service);
  }

  // GitHub Pages (workflow de deploy presente)
  for (const wf of _files_by_pattern([".github/workflows/*.yml", ".github/workflows/*.yaml"])) {
    let content;
    try {
      content = readTextIgnore(path.join(CWD, wf));
    } catch {
      continue;
    }
    if (content.includes("deploy-pages") || content.includes("configure-pages")) {
      details.hosting_configs.push("GitHub Pages");
      break;
    }
  }

  const deployScripts = _files_by_pattern(["deploy.sh", "deploy.py", "deploy.ps1", "scripts/deploy*"]);
  details.has_deploy_script = deployScripts.length > 0;

  const hasBuild = details.build_dir || details.dist_dir || details.out_dir ||
    details.public_dir || !!details._site_dir;

  let score = 0;
  if (hasBuild) score += 3;
  if (details.hosting_configs.length) score += Math.min(5, details.hosting_configs.length * 2);
  if (details.has_deploy_script) score += 2;
  return [Math.min(10, score), details];
}

function scanCodeQuality() {
  const details = { linters: [], formatters: [], type_checkers: [], editorconfig: false };

  const linterMap = {
    ".eslintrc.js": "ESLint", ".eslintrc.cjs": "ESLint", ".eslintrc.json": "ESLint",
    ".eslintrc.yaml": "ESLint", ".eslintrc.yml": "ESLint", ".eslintrc": "ESLint",
    "eslint.config.js": "ESLint", "eslint.config.mjs": "ESLint",
    ".pylintrc": "Pylint", ".flake8": "Flake8", ".rubocop.yml": "RuboCop",
    ".golangci.yml": "golangci-lint", ".golangci.yaml": "golangci-lint",
    "ruff.toml": "Ruff", ".ruff.toml": "Ruff",
    "biome.json": "Biome", "biome.jsonc": "Biome",
    ".clang-tidy": "clang-tidy",
    "analysis_options.yaml": "Dart Analyzer",
  };
  for (const [filename, tool] of Object.entries(linterMap)) {
    if (fs.existsSync(path.join(CWD, filename))) details.linters.push(tool);
  }

  const formatterMap = {
    ".prettierrc": "Prettier", ".prettierrc.json": "Prettier",
    ".prettierrc.yaml": "Prettier", ".prettierrc.yml": "Prettier",
    ".prettierrc.cjs": "Prettier",
    "prettier.config.js": "Prettier", "prettier.config.mjs": "Prettier",
    "prettier.config.cjs": "Prettier",
    ".clang-format": "clang-format",
    "rustfmt.toml": "rustfmt", ".rustfmt.toml": "rustfmt",
  };
  for (const [filename, tool] of Object.entries(formatterMap)) {
    if (fs.existsSync(path.join(CWD, filename))) details.formatters.push(tool);
  }

  if (fs.existsSync(path.join(CWD, "tsconfig.json"))) details.type_checkers.push("TypeScript");
  if (fs.existsSync(path.join(CWD, "pyproject.toml"))) {
    try {
      const content = readTextIgnore(path.join(CWD, "pyproject.toml"));
      if (content.includes("mypy")) details.type_checkers.push("mypy");
    } catch {
      /* OSError */
    }
  }
  if (fs.existsSync(path.join(CWD, "mypy.ini")) || fs.existsSync(path.join(CWD, ".mypy.ini"))) {
    details.type_checkers.push("mypy");
  }
  details.editorconfig = fs.existsSync(path.join(CWD, ".editorconfig"));

  let score = 0;
  score += Math.min(4, details.linters.length * 2);
  score += Math.min(2, details.formatters.length);
  score += Math.min(4, details.type_checkers.length * 2);
  if (details.editorconfig) score += 1;
  return [Math.min(10, score), details];
}

function scanDependencies() {
  const details = { files: [], has_lockfile: false };

  const depFiles = {
    "requirements.txt": "pip",
    "pyproject.toml": "Python (pyproject)",
    "setup.py": "Python (setup)",
    "Pipfile": "Pipenv",
    "package.json": "Node.js",
    "Cargo.toml": "Rust",
    "go.mod": "Go",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "pubspec.yaml": "Dart/Flutter",
    "build.gradle": "Android/Gradle",
    "build.gradle.kts": "Android/Gradle (Kotlin DSL)",
  };
  for (const [filename, label] of Object.entries(depFiles)) {
    if (fs.existsSync(path.join(CWD, filename))) details.files.push(label);
  }

  const lockfiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Pipfile.lock", "poetry.lock", "Cargo.lock", "Gemfile.lock",
    "composer.lock", "pubspec.lock", "requirements.lock"];
  for (const lf of lockfiles) {
    if (fs.existsSync(path.join(CWD, lf))) {
      details.has_lockfile = true;
      break;
    }
  }

  let score = 0;
  if (details.files.length) score += Math.min(7, details.files.length * 2);
  if (details.has_lockfile) score += 3;
  return [Math.min(10, score), details];
}

const SCANNERS = [
  ["repo_exists", scanRepoExists],
  ["git_maturity", scanGitMaturity],
  ["testing", scanTesting],
  ["cicd", scanCicd],
  ["documentation", scanDocumentation],
  ["security", scanSecurity],
  ["structure", scanStructure],
  ["deploy_evidence", scanDeployEvidence],
  ["code_quality", scanCodeQuality],
  ["dependencies", scanDependencies],
];

// ── Stack detection ───────────────────────────────────────────────────────────
function detectTechStack() {
  const langCounts = {
    Python: countLinesInExtensions([".py"]),
    JavaScript: countLinesInExtensions([".js", ".jsx"]),
    TypeScript: countLinesInExtensions([".ts", ".tsx"]),
    Dart: countLinesInExtensions([".dart"]),
    Java: countLinesInExtensions([".java"]),
    Kotlin: countLinesInExtensions([".kt"]),
    Go: countLinesInExtensions([".go"]),
    PHP: countLinesInExtensions([".php"]),
    "HTML/CSS": countLinesInExtensions([".html", ".css", ".scss", ".sass", ".less"]),
  };
  const active = Object.entries(langCounts).filter(([, v]) => v > 0);
  active.sort((a, b) => b[1] - a[1]); // desc, estable (ties → orden de inserción)

  const frameworkSignals = {};
  if (fs.existsSync(path.join(CWD, "pubspec.yaml"))) frameworkSignals.flutter = true;
  if (rglobRaw(["next.config.*"]).length) frameworkSignals.nextjs = true;
  if (rglobRaw(["vite.config.*"]).length) frameworkSignals.vite = true;
  if (rglobRaw(["manage.py"]).length) frameworkSignals.django = true;
  if (fs.existsSync(path.join(CWD, "composer.json"))) frameworkSignals.laravel = true;

  return {
    primary_language: active.length ? active[0][0] : "unknown",
    language_counts: Object.fromEntries(active),
    frameworks_detected: Object.keys(frameworkSignals),
  };
}

// ── Cuestionario interactivo ──────────────────────────────────────────────────
// Buffer de líneas + waiters: lee línea a línea hasta EOF sin la race de
// cierre de rl.question(). eofFlag solo se activa si EOF llega con una
// pregunta pendiente; si el EOF llega con todo respondido, no molesta.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lineBuffer = [];
const waiters = [];
let eofFlag = false;
let stdinClosed = false;

rl.on("line", (line) => {
  const w = waiters.shift();
  if (w) w(line);
  else lineBuffer.push(line);
});

rl.on("close", () => {
  stdinClosed = true;
  if (waiters.length) {
    eofFlag = true;
    while (waiters.length) waiters.shift()("");
  }
});

function ask(q) {
  process.stdout.write(q);
  if (lineBuffer.length) return Promise.resolve(lineBuffer.shift());
  // stdin ya cerrado (script vía pipe, /dev/null, EOF): responder con EOF
  if (stdinClosed) {
    eofFlag = true;
    return Promise.resolve("");
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function guardEof() {
  if (eofFlag) {
    console.error(`\n  ${red("✗ Entrada terminada (EOF) — no se pudo completar el cuestionario.")}`);
    console.error(`  ${yellow("Si usaste \"curl | node -\", el stdin se consume leyendo el código.")}`);
    console.error(`  ${yellow("Descargá el script o instalá el paquete: npm i -g ci-audit && ci-audit")}`);
    process.exit(1);
  }
}

function getDetectedGitRemote() {
  const [, stdout] = _run(["git", "remote", "-v"]);
  if (stdout.includes("origin")) {
    const m = stdout.match(/origin\s+(\S+)/);
    if (m) return m[1];
  }
  return "";
}

async function askRequired(question, errorMsg) {
  while (true) {
    const val = (await ask(question)).trim();
    guardEof();
    if (val) return val;
    console.log(`    ${yellow(`⚠ ${errorMsg}`)}`);
  }
}

async function askMembers() {
  console.log(`\n  ${bold("Integrantes del equipo")} (*al menos 1 obligatorio; enter vacío en nombre para terminar):`);
  const members = [];
  let i = 1;
  while (true) {
    const name = (await ask(`    #${i} Nombre: `)).trim();
    guardEof();
    if (!name) {
      if (members.length === 0) {
        console.log(`    ${yellow("⚠ Debes registrar al menos 1 integrante con nombre.")}`);
        continue;
      }
      break;
    }
    const role = (await ask(`    #${i} Rol (ej. backend, frontend, diseño): `)).trim();
    guardEof();
    members.push({ name, role });
    i += 1;
  }
  return members;
}

async function askTeamInfo() {
  console.log(`\n${bold("🧩 INFORMACIÓN DEL EQUIPO")}`);
  console.log("─".repeat(50));

  const teamName = await askRequired("  Nombre del equipo (*obligatorio): ", "El nombre del equipo es obligatorio.");
  const projectName = await askRequired("  Nombre del proyecto (*obligatorio): ", "El nombre del proyecto es obligatorio.");

  const detectedRemote = getDetectedGitRemote();
  const repoPrompt = detectedRemote
    ? `  URL del repositorio [detectado: ${detectedRemote}] (enter para usar este): `
    : `  URL del repositorio (enter si no tiene): `;
  let repoUrl = (await ask(repoPrompt)).trim();
  guardEof();
  if (!repoUrl && detectedRemote) {
    repoUrl = detectedRemote;
  }

  const demoUrl = (await ask("  URL de demo en vivo (enter si no tiene): ")).trim();
  guardEof();

  const teamCode = (await ask("  Código de acceso del programa (si lo tenés; enter para omitir): ")).trim();
  guardEof();

  const members = await askMembers();

  return {
    team_code: teamCode,
    team_name: teamName,
    project_name: projectName,
    repo_url: repoUrl,
    demo_url: demoUrl,
    members,
  };
}

async function reviewAndEditTeamInfo(team) {
  while (true) {
    console.log(`\n${bold("📋 REVISIÓN DE INFORMACIÓN DEL EQUIPO")}`);
    console.log("─".repeat(50));
    console.log(`  1. Nombre del equipo:   ${bold(team.team_name)}`);
    console.log(`  2. Nombre del proyecto: ${bold(team.project_name)}`);
    console.log(`  3. URL del repositorio: ${team.repo_url ? team.repo_url : yellow("(ninguna)")}`);
    console.log(`  4. URL de demo en vivo: ${team.demo_url ? team.demo_url : yellow("(ninguna)")}`);
    console.log(`  5. Código del programa: ${team.team_code ? team.team_code : yellow("(ninguno)")}`);
    console.log(`  6. Integrantes (${team.members.length}):`);
    for (const m of team.members) {
      console.log(`     • ${m.name}${m.role ? ` (${m.role})` : ""}`);
    }
    console.log("─".repeat(50));

    const choice = (await ask("  ¿La información es correcta? [Y: Confirmar / 1-6: Editar campo / E: Editar todo]: ")).trim().toLowerCase();
    guardEof();

    if (["", "y", "yes", "s", "sí", "si"].includes(choice)) {
      if (!team.team_name) {
        console.log(`  ${yellow("⚠ Falta el nombre del equipo.")}`);
        team.team_name = await askRequired("  Nuevo nombre del equipo: ", "El nombre del equipo es obligatorio.");
        continue;
      }
      if (!team.project_name) {
        console.log(`  ${yellow("⚠ Falta el nombre del proyecto.")}`);
        team.project_name = await askRequired("  Nuevo nombre del proyecto: ", "El nombre del proyecto es obligatorio.");
        continue;
      }
      if (!team.members || team.members.length === 0) {
        console.log(`  ${yellow("⚠ Debes registrar al menos 1 integrante.")}`);
        team.members = await askMembers();
        continue;
      }
      break;
    } else if (choice === "1") {
      team.team_name = await askRequired(`  Nuevo nombre del equipo [${team.team_name}]: `, "El nombre del equipo es obligatorio.");
    } else if (choice === "2") {
      team.project_name = await askRequired(`  Nuevo nombre del proyecto [${team.project_name}]: `, "El nombre del proyecto es obligatorio.");
    } else if (choice === "3") {
      const val = (await ask(`  Nueva URL del repositorio [${team.repo_url || "vacío"}] (usa '-' para borrar): `)).trim();
      guardEof();
      if (val !== "") team.repo_url = val === "-" ? "" : val;
    } else if (choice === "4") {
      const val = (await ask(`  Nueva URL de demo en vivo [${team.demo_url || "vacío"}] (usa '-' para borrar): `)).trim();
      guardEof();
      if (val !== "") team.demo_url = val === "-" ? "" : val;
    } else if (choice === "5") {
      const val = (await ask(`  Nuevo código de acceso [${team.team_code || "ninguno"}] (usa '-' para borrar): `)).trim();
      guardEof();
      if (val !== "") team.team_code = val === "-" ? "" : val;
    } else if (choice === "6") {
      team.members = await askMembers();
    } else if (choice === "e") {
      const updated = await askTeamInfo();
      Object.assign(team, updated);
    } else {
      console.log(`  ${yellow("Opción no válida. Ingresá 'y' para confirmar o el número de campo a editar (1-6).")}`);
    }
  }
  return team;
}

// ── POST a Google Sheets ───────────────────────────────────────────────────────
async function postToSheets(payload) {
  if (!GOOGLE_APPS_SCRIPT_URL) {
    console.log(`\n  ${yellow("⚠ Sin endpoint configurado. Modo dry-run.")}`);
    console.log(`  ${yellow("  Seteá CI_AUDIT_ENDPOINT o editar GOOGLE_APPS_SCRIPT_URL en el script.")}`);
    console.log(`  ${yellow("  Ver apps-script/README.md para desplegar el panel de evaluación.")}`);
    return { ok: false, message: "" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
    const res = await fetch(GOOGLE_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await res.text();
    let ok = res.ok;
    let message = "";
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.ok === "boolean") {
        ok = parsed.ok;
        message = parsed.message || parsed.error || "";
      }
    } catch {
      /* cuerpo no JSON: confiar en el status HTTP */
    }
    return { ok, message };
  } catch {
    return { ok: false, message: "" };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function isoNow() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds() * 1000, 6)}`;
}

async function main() {
  console.log(`\n${bold("🔍 ci-audit")} v${VERSION}`);
  console.log("CI Nicaragua — Auditoría de Madurez Técnica para Startups");
  console.log("Hackathon Nicaragua 2026\n");
  console.log(`Directorio de trabajo: ${CWD}`);
  console.log(`Timestamp: ${isoNow()}\n`);

  // stdin ya terminado (script vía pipe: curl | node -): el modo interactivo
  // no funciona porque stdin se usó para leer el código del script.
  if (process.stdin.readableEnded) {
    console.error(`\n  ${red("✗ No se puede ejecutar en modo interactivo.")}`);
    console.error(`\n  ${yellow("El comando \"curl | node -\" consume stdin para leer")}`);
    console.error(`  ${yellow("el código del script, por lo que no queda entrada disponible")}`);
    console.error(`  ${yellow("para responder el cuestionario interactivo.")}`);
    console.error(`\n  ${bold("Alternativas:")}`);
    console.error(`    ${bold("A.\u2002Con npx (Node 18+):")}`);
    console.error(`      npx ci-audit`);
    console.error(`\n    ${bold("B.\u2002Instalar globalmente:")}`);
    console.error(`      npm i -g ci-audit && ci-audit`);
    process.exit(1);
  }

  // 1. Cuestionario
  const teamInfo = await askTeamInfo();

  // 2. Scan automático
  console.log(`\n${bold("🔬 ESCANEANDO PROYECTO...")}`);
  console.log("─".repeat(50));

  const scores = {};
  const allDetails = {};
  let totalPoints = 0;

  for (const [key, scannerFn] of SCANNERS) {
    const meta = METRICS[key];
    const [rawScore, details] = scannerFn();
    const weight = meta.weight;
    const weighted = rawScore * weight; // puntos (peso relativo × raw)
    totalPoints += weighted;
    scores[key] = { raw: rawScore, weighted, label: meta.label };
    allDetails[key] = details;

    const icon = rawScore >= 7 ? "✅" : rawScore >= 3 ? "⚠️" : "❌";
    console.log(`  ${icon} ${meta.label.padEnd(20)} ${bar(rawScore)}  (×${weight} = ${weighted})`);
  }

  // Score normalizado asumiendo TODAS las categorías activas (referencial).
  // El score y tier finales se recalculan sobre el cohorte completo en
  // merge.js: se descartan las categorías donde todos dieron 0 y se
  // renormaliza (perfecto en categorías activas = 100).
  const composite = pyRound((totalPoints / MAX_POINTS) * 100, 1);

  // Stack detection
  const stack = detectTechStack();

  // 3. Resumen
  console.log(`\n${bold("📊 RESULTADO")}`);
  console.log("─".repeat(50));
  const tier = composite >= TIER_A_MIN ? "A" : composite >= TIER_B_MIN ? "B" : "C";
  const tierColor = tier === "A" ? green : tier === "B" ? yellow : red;
  console.log(`  Puntos: ${totalPoints}/${MAX_POINTS}`);
  console.log(`  Score normalizado: ${bold(composite.toFixed(1))}/100`);
  console.log(`  Tier (referencial): ${tierColor(`Tier ${tier}`)}`);
  console.log(`  ${yellow("  (El tier final se calcula sobre el cohorte completo de equipos: merge.js)")}`);
  console.log(`  Lenguaje principal: ${stack.primary_language}`);
  if (stack.frameworks_detected.length) {
    console.log(`  Frameworks: ${stack.frameworks_detected.join(", ")}`);
  }
  const totalLines = Object.values(stack.language_counts).reduce((a, b) => a + b, 0);
  console.log(`  Código detectado: ${totalLines} líneas`);

  // 4. Revisión y edición de datos del equipo
  let teamInfoFinal = await reviewAndEditTeamInfo(teamInfo);

  // 5. Construir payload
  const payload = {
    version: VERSION,
    timestamp: isoNow(),
    team: teamInfoFinal,
    scores,
    total_points: totalPoints,
    max_points: MAX_POINTS,
    composite_score: composite,
    tier,
    details: allDetails,
    stack,
    cwd: CWD,
  };

  // 6. Confirmar y enviar al panel
  console.log(`\n${bold("📤 ENVIAR RESULTADOS")}`);
  console.log("─".repeat(50));

  if (GOOGLE_APPS_SCRIPT_URL) {
    console.log(`  Endpoint: ${GOOGLE_APPS_SCRIPT_URL.slice(0, 60)}...`);
  } else {
    console.log(`  ${yellow("Endpoint no configurado — modo dry-run")}`);
  }

  const confirm = (await ask(`\n  ¿Enviar resultados al panel de evaluación? [Y/n]: `)).trim().toLowerCase();
  guardEof();
  if (["", "y", "yes", "s", "sí", "si"].includes(confirm)) {
    const sent = await postToSheets(payload);
    if (sent.ok) {
      console.log(`\n  ${green("✅ Resultados enviados al panel.")}`);
      if (sent.message) console.log(`  ${green(`   ${sent.message}`)}`);
      console.log(`  ${green("   Gracias por participar en el diagnóstico de madurez.")}`);
    } else {
      console.log(`\n  ${yellow("⚠ No se pudo enviar al panel.")}`);
      if (sent.message) console.log(`  ${yellow(`   ${sent.message}`)}`);
      console.log(`  ${yellow("   El resultado quedó guardado en ci-audit-result.json; podés reintentar luego.")}`);
    }
  } else {
    console.log(`\n  Envío cancelado. Los resultados no se guardaron.`);
  }

  // 6. Guardar localmente
  const localPath = path.join(CWD, "ci-audit-result.json");
  try {
    fs.writeFileSync(localPath, JSON.stringify(payload, null, 2));
    console.log(`  Resultado local guardado en: ${path.basename(localPath)}`);
  } catch {
    /* OSError */
  }

  console.log();
  rl.close();
  process.exitCode = composite >= TIER_B_MIN ? 0 : 1; // exit 0 = no rechazado (B o mejor)
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
