# Panel de evaluación — Google Apps Script

Web App que recibe los resultados de `ci_audit.cjs` y los registra en la
planilla del panel. **Sin API key**: la URL `/exec` es el acceso de facto y la
protección está en la validación server-side + el código de acceso por equipo.

## Despliegue (una sola vez, ~5 min)

1. Creá/abrí la **planilla del panel** en Google Sheets (la misma donde querés
   ver los resultados).

2. En esa planilla: **Extensiones → Apps Script** (el script queda vinculado a
   la planilla; su alcance se limita a ella).

3. En el editor, pegá el contenido de **`Code.gs`** y de **`appsscript.json`**
   (este último en *Configuración del proyecto → Mostrar archivo de manifiesto*).

4. **Implementar → Nueva implementación → Aplicación web**:
   - *Ejecutar como:* **Yo** (el dueño).
   - *Quién tiene acceso:* **Cualquier persona** (así el CLI de los equipos
     puede hacer POST anónimo; el script igual corre como dueño y solo en tu
     planilla).
   - Copiá la URL que termina en `/exec`.

5. Configurala en el scanner:

   ```bash
   CI_AUDIT_ENDPOINT=https://script.google.com/macros/s/XXX/exec node ci_audit.cjs
   ```

6. Probá con un repo de prueba (`node ci_audit.cjs` → confirmá el envío) y
   verificá que aparezca una fila en la pestaña **Resultados**.

> Para cambios futuros de código, usá **Implementar → Administrar
> implementaciones → Editar → Nueva versión**: conserva la MISMA URL. Una
> implementación *nueva* genera otra URL y los equipos tendrían que actualizar.

## Qué hace el script

| Pestaña | Contenido |
|---|---|
| `Resultados` | Una fila por envío (26 columnas: equipo, scores, detalles, digest…). Se crea sola. |
| `Setup` | `require_code` (`true/false`) y `team_codes` (lista separada por comas). Se crea sola. |

- **Validación**: estructura JSON, 10 métricas con `raw` 0-10, `composite_score`
  0-100, tamaño máx. 250 KB.
- **Anti-spam** (opcional): con `require_code=true` y códigos cargados en
  `Setup → team_codes`, se rechazan envíos sin `team_code` válido. El scanner
  pregunta el código al ejecutarse (`Código de acceso del programa`).
- **Dedupe**: si un equipo reenvía un resultado con el mismo contenido
  sustancial (mismo equipo, mismos scores y stack), se rechaza el duplicado.
  Re-ejecutar tras mejorar el proyecto SÍ genera una fila nueva (útil para ver
  evolución).

## Por qué no hay secretos que exponer

El scanner se distribuye abierto (`curl … | node -`), así que cualquier clave
que el cliente deba enviar sería legible por todos. Por eso el diseño no
depende de una clave: el script corre como el dueño con `spreadsheets.currentonly`
(solo su planilla), el payload se valida y deduplica en el servidor, y los
códigos por equipo limitan el spam. El peor daño posible de "filtrar la URL" es
filas basura, que quedan a la vista para revisión.