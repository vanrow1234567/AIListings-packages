import crypto from 'node:crypto';
import type http from 'node:http';

function sameSecret(actual: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(actual).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createGhlIngress(
  app: http.RequestListener,
  token: string,
): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method !== 'POST' || url.pathname !== '/ghl/audits') {
      res.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const expected = `Bearer ${token}`;
    const actual = req.headers.authorization ?? '';

    if (!sameSecret(actual, expected)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    req.headers['x-ailistings-ghl-ingress'] = '1';
    req.url = '/api/audits';
    app(req, res);
  };
}