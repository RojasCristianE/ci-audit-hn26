# Resumen Técnico y Guía de Uso — `ci-audit`

Auditoría de Madurez Técnica para Startups — **Hackathon Nicaragua 2026 / CI INATEC**.

---

## 1. Lo que se realizó

### A. Diagnóstico y Corrección de la Causa Raíz del Error HTTP 405
* **Diagnóstico**: Al hacer `POST` a una Web App de Apps Script, Google ejecuta `doPost(e)` en el servidor y devuelve un `HTTP 302 Found` cuya cabecera `Location` apunta a `https://script.googleusercontent.com/macros/echo?...`. Ese endpoint `echo` **solo acepta el método `GET`** para servir la respuesta.
  * En `curl`, el flag `-X POST` forzaba `POST` en todos los saltos de redirección, provocando el error `405 Method Not Allowed`.
  * En `ci_audit.cjs`, la función anterior repetía el `POST` al seguir manualmente el código `302`.
* **Solución**: Se actualizó `postToSheets` para usar la API estándar `fetch` (nativa de Node 18+) con `AbortController` (timeout de 30s) y `redirect: "follow"`. La especificación Fetch convierte automáticamente la redirección 302 a `GET`, completando el flujo con éxito.

### B. Validación de Calidad de Datos y Prevención de Ruido
* **Campos Obligatorios**: Se establecieron como obligatorios el nombre del equipo, el nombre del proyecto y al menos un integrante con nombre y rol.
* **Auto-detección de Git**: El scanner detecta automáticamente la URL del repositorio remoto (`git remote -v`) y la propone por defecto.
* **Flujo Interactivo de Revisión/Edición**: Tras escanear el proyecto y antes de enviar, el usuario ve una ficha con toda la información y puede editar campos individuales (`1-6`) o corregir todo antes de la confirmación final.
* **Validación en Backend (`apps-script/Code.gs`)**: Se reforzó `validate_` para rechazar en el servidor cualquier payload incompleto sin `project_name` o sin `members`.

### C. Inspección y Lectura de Datos
* Se añadió el parámetro `?format=json` al `doGet` de Apps Script para permitir la auditoría y consulta estructurada de las filas registradas en la hoja de cálculo.

---

## 2. Estado Actual del Proyecto

| Componente | Estado | Detalle |
|---|:---:|---|
| **Backend Apps Script** | **Producción (`@7`)** | Vinculado a la hoja de cálculo, ejecutando como dueño con scope mínimo `spreadsheets.currentonly`. |
| **Planilla Google Sheets** | **Activa y Verificada** | [Abrir Google Sheet](https://docs.google.com/spreadsheets/d/183COvxrF7mxjWuxYqlpn9dmayXfw_fjvpqb-W6U6eJ0/edit). Pestañas `Resultados` (26 columnas) y `Setup` operativas. |
| **Scanner CLI (`ci_audit.cjs`)** | **v1.0.0** | 10 métricas de escaneo, validación previa, interfaz de revisión interactiva y guardado local en `ci-audit-result.json`. |
| **Agregador (`merge.js`)** | **Listo** | Descarta métricas con 0 en toda la cohorte, normaliza y combina con rúbrica de mentores (60/40). |

---

## 3. Guía de Uso

### A. Para los Equipos Participantes (Startups)

Los equipos ejecutan el scanner en la raíz del repositorio de su proyecto:

```bash
CI_AUDIT_ENDPOINT="https://script.google.com/macros/s/AKfycbzX1vvcw9_xyN11C6puNhiO9vC8LUtEOU76NWIJ-MQxg5DzoESRppiB4QKkq4aJFCt7aA/exec" node ci_audit.cjs
```

*O vía npx / ejecución directa:*
```bash
CI_AUDIT_ENDPOINT="https://script.google.com/macros/s/AKfycbzX1vvcw9_xyN11C6puNhiO9vC8LUtEOU76NWIJ-MQxg5DzoESRppiB4QKkq4aJFCt7aA/exec" curl -s https://rojascristiane.github.io/ci-audit-hn26/ci_audit.cjs | node -
```

**Flujo que experimentará el equipo:**
1. Responde nombre del equipo, nombre del proyecto, repositorio (con autocompletado si hay git origin), demo y sus integrantes.
2. El CLI escanea automáticamente las 10 métricas técnicas (Git, Testing, CI/CD, Documentación, Seguridad, Estructura, Deploy, Calidad, Dependencias).
3. Muestra el resumen y el **panel de revisión**:
   * Si detectan un error tipográfico o quieren agregar otro integrante, eligen el número del campo para corregirlo.
   * Si todo está correcto, confirman con `Y` para enviarlo a la planilla.
4. Siempre se genera una copia local de respaldo en `ci-audit-result.json`.

---

### B. Para los Organizadores y Mentores

#### 1. Configuración de Acceso Anti-Spam (Opcional)
En la pestaña **`Setup`** de la hoja de cálculo:
* `require_code`: cambiar a `true` si se quiere exigir un código a los equipos.
* `team_codes`: lista separada por comas de los códigos autorizados (ej. `hn26-alpha,hn26-beta`).

#### 2. Generación del Tier List Final de la Cohorte
Una vez que todos los equipos hayan enviado sus resultados (o teniendo los archivos JSON locales):

```bash
node merge.js --results <directorio_de_jsons_o_archivo> [--mentor data/mentor_observations.json] [--out tier-list.json]
```

* Descarta automáticamente las categorías donde nadie sumó puntos en la cohorte.
* Genera la distribución de Tiers: **Tier A (≥65)**, **Tier B (45-64)**, **Tier C (<45)**.
