# Proxy de reseñas: Klaviyo → escaparate

La API de reseñas de Klaviyo exige una **private key** (scope `reviews:read`). El HTML y el JS de
un tema Shopify son públicos, y las private keys de Klaviyo **no se pueden restringir por dominio**:
si la key va en el tema, cualquiera la saca con `view-source` y sirve desde donde quiera hasta que
la rotes. Por eso existe este servicio.

```
navegador  ──GET /reviews?product=optimum&language=es──▶  Railway  ──private key──▶  Klaviyo
```

El navegador nunca ve la key: solo JSON ya filtrado.

## API

`GET /reviews`

| Parámetro    | Por defecto | Qué hace                                          |
| ------------ | ----------- | ------------------------------------------------- |
| `product`    | (todos)     | `optimum` \| `optimum-men`                        |
| `language`   | (todos)     | Código ISO 639-1: `es`, `en`…                     |
| `min_rating` | `4`         | Nota mínima                                       |
| `limit`      | `12`        | Máximo de reseñas (tope 50)                       |

```json
{ "reviews": [{ "id": "…", "author": "Rocío S.", "quote": "…", "content": "…", "rating": 4, "verified": false, "language": "es", "product_key": "optimum", "date": "2026-04-11" }], "count": 1 }
```

`GET /health` → `{ "ok": true, "cached": true, "count": 34 }`

## Desplegar en Railway

Este repo es solo el proxy: Railway detecta Node, instala y lanza `npm start`. No hace falta
tocar el Root Directory ni escribir un Dockerfile.

1. Sube esta carpeta a GitHub:

   ```bash
   git init && git add . && git commit -m "Proxy de reseñas de Klaviyo"
   gh repo create youroptimum-reviews-proxy --private --source=. --push
   ```

2. Railway → **New Project → Deploy from GitHub repo** → elige el repo.
3. En **Variables**, añade lo de [`.env.example`](.env.example). Como mínimo:
   - `KLAVIYO_PRIVATE_KEY` — créala en Klaviyo: *Settings → API keys → Create private key*, con
     **solo** el scope `reviews:read`. Si esta key se filtrase, lo peor que puede hacer alguien es
     leer reseñas que ya son públicas.
   - `ALLOWED_ORIGINS` — los orígenes del escaparate, separados por comas. Sin esto el proxy
     responde a cualquiera y te lo pueden usar de API gratis.
4. **Settings → Networking → Generate Domain**. Te dará algo como
   `https://youroptimum-reviews-proxy-production.up.railway.app`.
5. `PORT` lo inyecta Railway solo. No lo definas.

`.env` está en el `.gitignore`: la key se pone en las Variables de Railway, nunca en el repo.

Comprueba que vive:

```bash
curl https://TU-DOMINIO.up.railway.app/health
curl 'https://TU-DOMINIO.up.railway.app/reviews?product=optimum&language=es'
```

## Conectarlo al tema

En el editor de temas, sección **Testimonios text** → **URL del proxy de reseñas**:

```
https://TU-DOMINIO.up.railway.app/reviews
```

Si se deja vacío, la sección muestra solo los bloques manuales. La sección renderiza siempre esos
bloques en el servidor y el JS los sustituye cuando llegan las reseñas: si el proxy se cae, el
carrusel sigue lleno en vez de quedarse en blanco.

## Detalles que conviene recordar

- **Caché en memoria (10 min).** Klaviyo limita el endpoint de reseñas a ~3 req/s, así que no puede
  haber una llamada por pageview. Se guarda una sola copia para todas las visitas, y si Klaviyo
  falla se sirve la copia caducada antes que romper la sección. Ajustable con `CACHE_TTL_MS`.
  Consecuencia: una reseña nueva tarda hasta 10 minutos en salir. Si Railway duerme el servicio,
  la caché se pierde y la primera visita paga la llamada a Klaviyo.
- **El producto se resuelve por el handle exacto de la URL**, no por el nombre. Con búsqueda por
  subcadena, *"FREE -Neceser Optimum"* contiene `optimum` y las reseñas del neceser se colarían
  como testimonios del suplemento. Para añadir productos, edita `PRODUCT_MAP` (handle → clave de
  la sección) y añade la opción en el `select` `product_key` de la sección.
- **El idioma se detecta aquí** con `franc-min` sobre el texto, acotado a los idiomas del
  escaparate (eso es lo que lo hace fiable en textos cortos). Si no se decide, cae en `es`.
- **`author_meta`** (el "38 años, Madrid" del diseño) **no existe en Klaviyo**. Las tarjetas de
  Klaviyo muestran solo el nombre; los bloques manuales sí pueden llevarlo.
- El cuerpo de la reseña lo escribe un cliente y llega sin sanear: la sección lo pinta con
  `textContent`, nunca con `innerHTML`.
