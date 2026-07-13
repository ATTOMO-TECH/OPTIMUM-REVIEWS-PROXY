/**
 * Todo lo que toca Klaviyo: normalizado, filtros y caché en memoria.
 * `server.js` solo se ocupa del HTTP.
 */

import { franc } from 'franc-min';

const {
  KLAVIYO_PRIVATE_KEY,
  KLAVIYO_REVISION = '2025-07-15',
  PRODUCT_MAP: PRODUCT_MAP_ENV,
  CACHE_TTL_MS = '600000',
} = process.env;

/**
 * Handle del producto en Shopify -> `product_key` de la sección.
 *
 * Se compara contra el handle exacto (el último segmento de la URL de la reseña), no contra
 * subcadenas del nombre: "FREE -Neceser Optimum" contiene "optimum" y, con una búsqueda por
 * subcadena, las reseñas del neceser acabarían mostrándose como testimonios del suplemento.
 */
export const DEFAULT_PRODUCT_MAP = {
  optimum: 'optimum',
  'optimum-men': 'optimum-men',
};
const PRODUCT_MAP = PRODUCT_MAP_ENV ? JSON.parse(PRODUCT_MAP_ENV) : DEFAULT_PRODUCT_MAP;

/** Idiomas que puede tener el escaparate. Acotar franc mejora mucho su precisión. */
const LANGUAGES = { spa: 'es', eng: 'en', fra: 'fr', ita: 'it', deu: 'de', por: 'pt' };
const FALLBACK_LANGUAGE = 'es';

/** Una reseña sin cuerpo o sin autor no llena una tarjeta. */
const MIN_CONTENT_LENGTH = 40;
const TTL = Number(CACHE_TTL_MS);

export function productHandle(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.at(-1) ?? '';
  } catch {
    return '';
  }
}

export function detectLanguage(text) {
  const code = franc(text, { only: Object.keys(LANGUAGES), minLength: 20 });
  return LANGUAGES[code] ?? FALLBACK_LANGUAGE;
}

export function normalize(review, productMap = PRODUCT_MAP) {
  const { attributes: a, id } = review;
  const content = (a.content ?? '').trim();

  return {
    id,
    product_key: productMap[productHandle(a.product?.url)] ?? null,
    content,
    // `smart_quote` es el titular corto que genera Klaviyo; si no existe, usamos el título.
    quote: (a.smart_quote || a.title || '').trim(),
    author: (a.author ?? '').trim(),
    rating: a.rating ?? 0,
    verified: Boolean(a.verified),
    language: detectLanguage(content),
    date: (a.created ?? '').slice(0, 10),
  };
}

/** Descarta lo que no puede pintar una tarjeta decente. Los filtros de la sección van aparte. */
export function isRenderable(review) {
  return Boolean(review.product_key) && Boolean(review.author) && review.content.length >= MIN_CONTENT_LENGTH;
}

/** Filtros que sí dependen de la sección (producto, idioma, nota mínima). */
export function select(reviews, { product, language, minRating = 4, limit = 12 } = {}) {
  return reviews
    .filter((review) => !product || review.product_key === product)
    .filter((review) => review.rating >= minRating)
    .filter((review) => !language || review.language === language)
    .slice(0, limit);
}

export async function fetchAllReviews() {
  const params = new URLSearchParams({
    filter: 'equals(status,"published")',
    'page[size]': '100',
    sort: '-created',
  });

  let url = `https://a.klaviyo.com/api/reviews?${params}`;
  const reviews = [];

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
        accept: 'application/vnd.api+json',
        revision: KLAVIYO_REVISION,
      },
    });

    if (!response.ok) {
      throw new Error(`Klaviyo ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    reviews.push(...payload.data);
    url = payload.links?.next ?? null;
  }

  return reviews.map((review) => normalize(review)).filter(isRenderable);
}

// ---------------------------------------------------------------- Caché

let cache = { reviews: null, expires: 0 };
let inflight = null;

/**
 * Una sola copia en memoria para todas las visitas: Klaviyo limita el endpoint de reseñas a
 * ~3 req/s, así que no puede haber una llamada por pageview. `inflight` evita además que un
 * pico de tráfico con la caché fría dispare N peticiones simultáneas contra Klaviyo.
 */
export function getReviews(fetcher = fetchAllReviews) {
  if (cache.reviews && Date.now() < cache.expires) return Promise.resolve(cache.reviews);
  if (inflight) return inflight;

  inflight = fetcher()
    .then((reviews) => {
      cache = { reviews, expires: Date.now() + TTL };
      console.log(`Klaviyo: ${reviews.length} reseñas cacheadas ${TTL / 1000}s`);
      return reviews;
    })
    .catch((error) => {
      // Si Klaviyo falla pero queda una copia vieja, servirla es mejor que romper la sección.
      if (cache.reviews) {
        console.error(`Klaviyo falló, se sirve la caché caducada: ${error.message}`);
        return cache.reviews;
      }
      throw error;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function cacheState() {
  return { cached: Boolean(cache.reviews), count: cache.reviews?.length ?? 0 };
}
