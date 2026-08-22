# ci-audit — Auditoría de Madurez Técnica

> Programa de Incubación de Startups — Hackathon Nicaragua 2026 · Centro de Innovación INATEC

Auditoría automatizada de la madurez técnica **real** de tu proyecto: escanea el
código y el historial de git y puntúa 10 métricas objetivas (git, testing, CI/CD,
documentación, seguridad, estructura, evidencia de deploy, calidad, dependencias) en
una escala 0-100 con tier: **A** (≥65, al Hackathon) · **B** (45-64, condicional) ·
**C** (<45, al margen).

## Ejecutar

```bash
# Dentro de la raíz de tu proyecto:
node ci_audit.cjs

# O sin descargar el repositorio (Node 18+):
curl -s https://rojascristiane.github.io/ci-audit-hn26/ci_audit.cjs | node -
```

El scanner te hará unas preguntas breves sobre tu equipo, escaneará el proyecto y
guardará el resultado en `ci-audit-result.json`. Con el endpoint configurado
te pedirá confirmación para enviarlo al panel de evaluación:

```bash
CI_AUDIT_ENDPOINT=https://script.google.com/macros/s/XXXX/exec node ci_audit.cjs
```

## Panel de evaluación (backend)

El panel es una Web App de Google Apps Script (sin API key: la protección está en la
validación server-side y en el código de acceso por equipo). Código y pasos de
despliegue en [`apps-script/`](apps-script/README.md).
