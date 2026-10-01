# Guia de Uso: Sandi Ads

## Que es Sandi Ads?

Sandi Ads es un servidor MCP (Model Context Protocol) que conecta Claude con herramientas especializadas para operaciones de sitios web. Incluye integracion completa con Google Marketing Platform, analisis SEO, monitoreo de rendimiento, seguridad y mas.

**En palabras simples:** Es como tener un equipo completo de marketing digital, SEO, DevOps y seguridad web disponible directamente en Claude.

---

## Inicio Rapido

### En Claude Desktop

1. Configura el MCP en `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "sandi-ads": {
      "command": "node",
      "args": ["/ruta/a/sandi-ads/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "tu-client-id",
        "GOOGLE_CLIENT_SECRET": "tu-client-secret",
        "GOOGLE_REFRESH_TOKEN": "tu-refresh-token",
        "GOOGLE_PAGESPEED_API_KEY": "tu-api-key",
        "CLOUDFLARE_API_TOKEN": "tu-token"
      }
    }
  }
}
```

2. Reinicia Claude Desktop
3. Pide lo que necesitas en lenguaje natural

---

## Modulos Disponibles

### 1. Google Analytics 4 (GA4)

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `ga4_list_accounts` | Lista cuentas de Analytics | "Muestrame mis cuentas de GA4" |
| `ga4_list_properties` | Lista propiedades | "Que propiedades tengo en Analytics?" |
| `ga4_run_report` | Ejecuta reportes | "Dame el trafico de los ultimos 7 dias" |
| `ga4_run_realtime_report` | Datos en tiempo real | "Cuantos usuarios hay ahora?" |
| `ga4_list_audiences` | Lista audiencias | "Que audiencias tengo configuradas?" |
| `ga4_run_funnel_report` | Analisis de embudo | "Analiza el embudo de conversion" |

**Ejemplos de uso:**
- "Muestrame las paginas mas visitadas de mi sitio en GA4"
- "Cual es la tasa de rebote por dispositivo?"
- "Cuantas conversiones tuve este mes?"

---

### 2. Google Search Console (GSC)

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `gsc_list_sites` | Lista sitios verificados | "Que sitios tengo en Search Console?" |
| `gsc_query_analytics` | Busquedas y clics | "Cuales son mis keywords principales?" |
| `gsc_inspect_url` | Inspeccionar URL | "Inspecciona esta pagina en Google" |
| `gsc_list_sitemaps` | Lista sitemaps | "Que sitemaps tengo enviados?" |
| `gsc_submit_sitemap` | Enviar sitemap | "Envia mi sitemap a Google" |
| `gsc_coverage_report` | Reporte de cobertura | "Como esta mi indexacion?" |

**Ejemplos de uso:**
- "Cuales son las busquedas que traen mas trafico?"
- "Que paginas tienen errores de indexacion?"
- "Inspecciona si Google puede ver mi nueva pagina"

---

### 3. Google Tag Manager (GTM)

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `gtm_list_accounts` | Lista cuentas GTM | "Muestrame mis cuentas de GTM" |
| `gtm_list_containers` | Lista contenedores | "Que contenedores tengo?" |
| `gtm_list_tags` | Lista etiquetas | "Que tags tengo configurados?" |
| `gtm_list_triggers` | Lista disparadores | "Muestrame los triggers" |
| `gtm_list_variables` | Lista variables | "Que variables tengo?" |
| `gtm_get_version` | Version actual | "Cual es la version publicada?" |
| `gtm_create_version` | Crear version | "Crea una nueva version" |
| `gtm_publish_version` | Publicar version | "Publica la version X" |

**Ejemplos de uso:**
- "Lista todos los tags de Google Ads en mi contenedor"
- "Que triggers activan el tag de conversion?"
- "Crea y publica una nueva version de GTM"

---

### 4. Google Ads

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `ads_list_customers` | Lista cuentas | "Muestrame mis cuentas de Ads" |
| `ads_list_campaigns` | Lista campanas | "Que campanas tengo activas?" |
| `ads_campaign_performance` | Rendimiento | "Como van mis campanas?" |
| `ads_search_term_report` | Terminos de busqueda | "Que buscan los usuarios?" |
| `ads_create_campaign` | Crear campana | "Crea una campana de Search" |
| `ads_update_campaign` | Actualizar campana | "Pausa la campana X" |
| `ads_get_keyword_ideas` | Ideas de keywords | "Dame ideas de keywords para..." |
| `ads_add_keywords` | Agregar keywords | "Agrega estas keywords al grupo" |

**Ejemplos de uso:**
- "Cual es el CPC promedio de mis campanas?"
- "Que terminos de busqueda activan mis anuncios?"
- "Dame ideas de keywords para 'zapatos deportivos'"

---

### 5. Google Business Profile (GBP)

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `gbp_list_accounts` | Lista cuentas | "Mis cuentas de Business Profile" |
| `gbp_list_locations` | Lista ubicaciones | "Que locales tengo?" |
| `gbp_get_location` | Detalle ubicacion | "Informacion de mi local" |
| `gbp_list_reviews` | Lista resenas | "Muestrame las resenas" |
| `gbp_reply_review` | Responder resena | "Responde a esta resena" |
| `gbp_get_insights` | Estadisticas | "Como va mi perfil?" |
| `gbp_list_posts` | Lista posts | "Que posts tengo?" |
| `gbp_create_post` | Crear post | "Crea un post de oferta" |

**Ejemplos de uso:**
- "Cuantas resenas nuevas tengo esta semana?"
- "Como me encuentran los clientes en Google Maps?"
- "Crea un post promocionando mi nuevo producto"

---

### 6. Indexing API

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `indexing_url_updated` | Notificar actualizacion | "Indexa mi nueva pagina" |
| `indexing_url_deleted` | Notificar eliminacion | "Esta pagina ya no existe" |
| `indexing_batch_update` | Lote actualizaciones | "Indexa estas 10 URLs" |
| `indexing_get_status` | Estado de indexacion | "Estado de indexacion de X" |

**Ejemplos de uso:**
- "Pide a Google que indexe mi nueva pagina de producto"
- "Notifica que elimine estas 5 URLs"

---

### 7. Rendimiento (PageSpeed, CrUX, Lighthouse)

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `psi_analyze` | PageSpeed Insights | "Analiza la velocidad de mi sitio" |
| `crux_query` | Chrome UX Report | "Datos reales de usuarios" |
| `crux_history` | Historial CrUX | "Tendencia de Core Web Vitals" |
| `cwv_report` | Core Web Vitals | "Reporte de Web Vitals" |
| `lighthouse_audit` | Auditoria completa | "Auditoria Lighthouse completa" |

**Ejemplos de uso:**
- "Cual es mi puntaje de PageSpeed en movil?"
- "Como estan mis Core Web Vitals?"
- "Que puedo mejorar para cargar mas rapido?"

---

### 8. Seguridad

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `security_ssl_analyze` | Analisis SSL | "Revisa mi certificado SSL" |
| `security_headers_check` | Headers de seguridad | "Tengo los headers correctos?" |
| `security_audit` | Auditoria completa | "Auditoria de seguridad" |
| `security_safe_browsing` | Safe Browsing | "Mi sitio esta en lista negra?" |

**Ejemplos de uso:**
- "Mi SSL tiene grado A+?"
- "Que headers de seguridad me faltan?"
- "Google considera mi sitio seguro?"

---

### 9. SEO Tecnico

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `seo_robots_analyze` | Analizar robots.txt | "Revisa mi robots.txt" |
| `seo_robots_test` | Probar URL | "Google puede ver /admin?" |
| `seo_sitemap_analyze` | Analizar sitemap | "Mi sitemap esta bien?" |
| `seo_meta_analyze` | Meta tags | "Como se ve en Google?" |
| `seo_structured_data` | Datos estructurados | "Tengo schema markup?" |
| `seo_redirect_check` | Redirecciones | "A donde redirige esta URL?" |
| `seo_canonical_check` | Canonicals | "Revisa duplicados" |
| `seo_heading_analysis` | Estructura H1-H6 | "Mis encabezados estan bien?" |

**Ejemplos de uso:**
- "Estoy bloqueando algo importante en robots.txt?"
- "Mi sitemap tiene URLs con error?"
- "Que datos estructurados deberia agregar?"

---

### 10. Accesibilidad

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `a11y_audit` | Auditoria WCAG | "Auditoria de accesibilidad" |
| `a11y_check_contrast` | Contraste de colores | "Los colores son accesibles?" |
| `a11y_check_images` | Alt en imagenes | "Mis imagenes tienen alt?" |

**Ejemplos de uso:**
- "Mi sitio cumple con WCAG 2.1 AA?"
- "Que problemas de accesibilidad tengo?"
- "Cuantas imagenes les falta texto alternativo?"

---

### 11. Cloudflare

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `cf_list_zones` | Lista zonas/dominios | "Mis dominios en Cloudflare" |
| `cf_get_zone` | Detalle de zona | "Configuracion de mi dominio" |
| `cf_dns_records` | Registros DNS | "Muestrame los DNS" |
| `cf_analytics` | Estadisticas | "Trafico por Cloudflare" |
| `cf_firewall_events` | Eventos firewall | "Ataques bloqueados" |
| `cf_purge_cache` | Limpiar cache | "Limpia el cache de mi sitio" |
| `cf_page_rules` | Reglas de pagina | "Que page rules tengo?" |

**Ejemplos de uso:**
- "Cuantos ataques bloqueo Cloudflare hoy?"
- "Limpia el cache de mi dominio"
- "Muestrame las estadisticas de bandwidth"

---

### 12. Utilidades

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `util_tech_detection` | Detectar tecnologias | "Con que esta hecho X?" |
| `util_broken_links` | Enlaces rotos | "Busca links rotos" |
| `util_whois` | Info de dominio | "Quien es dueno de X?" |
| `util_headers` | Headers HTTP | "Muestrame los headers" |
| `util_screenshot` | Captura de pantalla | "Screenshot de la pagina" |

---

### 13. Monitoreo

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `monitor_uptime` | Estado del sitio | "Mi sitio esta arriba?" |
| `monitor_dns_lookup` | Consulta DNS | "Registros DNS de X" |
| `monitor_ssl_expiry` | Vencimiento SSL | "Cuando vence mi SSL?" |

---

### 14. Reportes

| Herramienta | Descripcion | Ejemplo |
|-------------|-------------|---------|
| `report_site_health` | Salud del sitio | "Reporte completo de salud" |
| `report_seo_audit` | Auditoria SEO | "Auditoria SEO completa" |
| `report_executive_summary` | Resumen ejecutivo | "Resumen para directivos" |

**Ejemplos de uso:**
- "Genera un reporte completo de mi sitio"
- "Necesito un resumen ejecutivo del estado web"

---

## Prompts Predefinidos

El MCP incluye prompts optimizados para tareas comunes:

| Prompt | Descripcion | Uso |
|--------|-------------|-----|
| `seo-analysis` | Analisis SEO completo | "Usa el prompt seo-analysis para ejemplo.com" |
| `performance-review` | Revision de rendimiento | "Usa performance-review para mi sitio" |
| `security-audit` | Auditoria de seguridad | "Ejecuta security-audit en mi dominio" |
| `gtm-setup-guide` | Guia de configuracion GTM | "Ayudame a configurar GTM" |
| `analytics-insights` | Insights de Analytics | "Dame insights de mi GA4" |

---

## Recursos MCP

El servidor expone recursos que Claude puede leer:

| Recurso | URI | Descripcion |
|---------|-----|-------------|
| Sitio actual | `site://current` | Configuracion del sitio activo |
| Lista de sitios | `site://list` | Todos los sitios configurados |
| Credenciales | `credentials://status` | Estado de las credenciales |

---

## Configuracion de Credenciales

### Google OAuth 2.0
```env
GOOGLE_CLIENT_ID=tu-client-id
GOOGLE_CLIENT_SECRET=tu-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
GOOGLE_REFRESH_TOKEN=tu-refresh-token
```

### Google Service Account
```env
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/ruta/a/service-account.json
```

### Google API Keys
```env
GOOGLE_PAGESPEED_API_KEY=tu-api-key
GOOGLE_SAFE_BROWSING_API_KEY=tu-api-key
```

### Google Ads
```env
GOOGLE_ADS_DEVELOPER_TOKEN=tu-developer-token
GOOGLE_ADS_LOGIN_CUSTOMER_ID=123-456-7890
```

### Cloudflare
```env
CLOUDFLARE_API_TOKEN=tu-token
```

---

## Ejemplos de Conversaciones

### Analisis Completo de un Sitio
```
Usuario: Analiza completamente mi sitio ejemplo.com

Claude: Voy a realizar un analisis completo que incluye:
- Rendimiento (PageSpeed)
- SEO tecnico
- Seguridad
- Accesibilidad
[Ejecuta multiples herramientas y presenta resultados]
```

### Optimizacion de Campanas
```
Usuario: Como puedo mejorar mis campanas de Google Ads?

Claude: Analizare tus campanas actuales...
[Usa ads_campaign_performance, ads_search_term_report]
Recomendaciones:
1. Keywords negativas sugeridas
2. Ajustes de pujas
3. Oportunidades de nuevas keywords
```

### Diagnostico de Indexacion
```
Usuario: Por que mi nueva pagina no aparece en Google?

Claude: Voy a investigar...
[Usa gsc_inspect_url, seo_robots_test, seo_canonical_check]
El problema es: [diagnostico]
Solucion: [pasos a seguir]
```

---

## Limitaciones

1. **Solo lectura en la mayoria de APIs** - Modificaciones limitadas
2. **Requiere credenciales validas** - Cada API necesita autenticacion
3. **Rate limits** - Respeta limites de las APIs de Google
4. **Solo sitios publicos** - No accede a intranets
5. **No ejecuta JavaScript** - Analisis estatico del HTML

---

## Solucion de Problemas

### El MCP no conecta
1. Verifica que Node.js 20+ este instalado
2. Revisa la ruta al archivo dist/index.js
3. Verifica las variables de entorno

### Error de autenticacion Google
1. Regenera el refresh token
2. Verifica los scopes necesarios
3. Revisa que la cuenta tenga acceso

### Herramienta no disponible
1. Verifica que las credenciales correspondientes esten configuradas
2. Algunas APIs requieren acceso especial (ej: GBP Reviews)

---

## Recursos Adicionales

- [Documentacion de Google APIs](https://developers.google.com/)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Cloudflare API](https://developers.cloudflare.com/api/)

---

*Version: 0.1.0*
*Ultima actualizacion: Enero 2026*
*~118 herramientas disponibles*
