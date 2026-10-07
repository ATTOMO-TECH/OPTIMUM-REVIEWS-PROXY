#!/usr/bin/env node
/**
 * Proxy de reseñas: el escaparate llama aquí, y este servicio llama a Klaviyo.
 *
 * La API de reseñas de Klaviyo exige una private key, y el HTML y el JS de un tema Shopify
 * son públicos, así que la key no puede vivir en el tema. Vive aquí (Railway) y al navegador
 * solo le llega JSON ya filtrado.
 *
 *   GET /reviews?products=optimum,optimum-men&language=es&min_rating=4&limit=12
 *   (`product=` singular sigue funcionando como alias con un solo producto)
 *   GET /health
 */

import { createServer } from 'node:http';
import { getReviews, select, cacheState } from './klaviyo.js';

const { KLAVIYO_PRIVATE_KEY, ALLOWED_ORIGINS = '', PORT = '3000' } = process.env;

if (!KLAVIYO_PRIVATE_KEY) {
  console.error('Falta KLAVIYO_PRIVATE_KEY (private key de Klaviyo con scope reviews:read).');
  process.exit(1);
}

const ALLOWED = ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!ALLOWED.length) {
  console.warn('ALLOWED_ORIGINS vacío: se responde a cualquier origen. Defínelo en producción.');
}

function corsHeaders(origin) {
  if (!ALLOWED.length) return { 'Access-Control-Allow-Origin': '*' };
  if (!ALLOWED.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

function send(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const cors = corsHeaders(request.headers.origin ?? '');
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
    return response.end();
  }

  if (url.pathname === '/health') {
    return send(response, 200, { ok: true, ...cacheState() });
  }

  if (url.pathname !== '/reviews' || request.method !== 'GET') {
    return send(response, 404, { error: 'Not found' }, cors);
  }

  try {
    const requestedProducts = (url.searchParams.get('products') ?? url.searchParams.get('product') ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);

    const reviews = select(await getReviews(), {
      products: requestedProducts,
      language: url.searchParams.get('language'),
      minRating: Number(url.searchParams.get('min_rating') ?? 4),
      limit: Math.min(Number(url.searchParams.get('limit') ?? 12), 50),
    });

    send(
      response,
      200,
      { reviews, count: reviews.length },
      {
        ...cors,
        // El navegador y la CDN pueden reutilizar la respuesta; el TTL real lo manda la caché de klaviyo.js.
        'Cache-Control': 'public, max-age=300',
      }
    );
  } catch (error) {
    console.error(error);
    send(response, 502, { error: 'No se pudieron obtener las reseñas' }, cors);
  }
});

server.listen(Number(PORT), () => {
  console.log(`Reviews proxy escuchando en :${PORT}`);
});
