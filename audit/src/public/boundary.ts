import type http from 'node:http';

const TOKEN = '[A-Za-z0-9_-]{43}';

const PUBLIC_GET = new RegExp(
  `^/a/${TOKEN}(?:/(?:cta|evidence/[A-Za-z0-9_.-]+\\.png))?$`,
);

const PUBLIC_ENGAGED = new RegExp(
  `^/a/${TOKEN}/engaged$`,
);

export function isAllowedPublicRequest(
  method: string | undefined,
  pathname: string,
): boolean {
  if (method === 'GET') return PUBLIC_GET.test(pathname);
  if (method === 'POST') return PUBLIC_ENGAGED.test(pathname);
  return false;
}

export function createPublicBoundary(
  app: http.RequestListener,
): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (!isAllowedPublicRequest(req.method, url.pathname)) {
      res.writeHead(404, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      });

      res.end(
        '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;margin:40px">This report link is not valid.</p>',
      );

      return;
    }

    app(req, res);
  };
}