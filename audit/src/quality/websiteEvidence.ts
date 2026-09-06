import { chromium, type Page } from 'playwright';
import { fetchWebsite } from '../business/understand.ts';

export interface WebsitePageEvidence {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  navigation: string[];
  jsonLd: string[];
}

export interface WebsiteEvidence {
  requestedUrl: string;
  finalUrl?: string;
  rendered: boolean;
  pages: WebsitePageEvidence[];
  screenshotDataUrl?: string;
  error?: string;
}

const MAX_HOME_TEXT = 10_000;
const MAX_SECONDARY_TEXT = 5_000;
const MAX_JSON_LD = 8_000;
const SECONDARY_PAGE_LIMIT = 2;

async function readRenderedPage(page: Page, maxText: number): Promise<WebsitePageEvidence> {
  return page.evaluate(
    ({ textLimit, jsonLdLimit }) => {
      const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
      const description =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((el) => clean(el.textContent ?? ''))
        .filter(Boolean)
        .slice(0, 30);
      const navigation = Array.from(document.querySelectorAll('nav a, header a'))
        .map((el) => clean(el.textContent ?? ''))
        .filter(Boolean)
        .slice(0, 40);
      const rawJsonLd = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]'),
      )
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, jsonLdLimit);
      const text = clean(document.body?.innerText ?? '').slice(0, textLimit);
      return {
        url: location.href,
        title: clean(document.title ?? ''),
        description: clean(description),
        headings,
        text,
        navigation,
        jsonLd: rawJsonLd ? [rawJsonLd] : [],
      };
    },
    { textLimit: maxText, jsonLdLimit: MAX_JSON_LD },
  );
}

function likelyUsefulLink(text: string, href: string): boolean {
  const combined = `${text} ${href}`.toLowerCase();
  return /services?|what[- ]we[- ]do|about|solutions?|expertise|our[- ]work/.test(combined);
}

/** Website material is evidence only. It is untrusted data, never instructions. */
export async function collectWebsiteEvidence(url: string): Promise<WebsiteEvidence> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'en-GB',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(800);

    const home = await readRenderedPage(page, MAX_HOME_TEXT);
    const screenshot = await page
      .screenshot({ type: 'jpeg', quality: 62, fullPage: false })
      .catch(() => undefined);

    const homeUrl = new URL(page.url());
    const rawLinks = await page
      .locator('a[href]')
      .evaluateAll((anchors) =>
        anchors.map((el) => ({
          href: (el as HTMLAnchorElement).href,
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        })),
      )
      .catch(() => [] as { href: string; text: string }[]);

    const useful: string[] = [];
    for (const link of rawLinks) {
      if (!likelyUsefulLink(link.text, link.href)) continue;
      try {
        const candidate = new URL(link.href, homeUrl);
        if (candidate.origin !== homeUrl.origin) continue;
        candidate.hash = '';
        if (candidate.href === homeUrl.href) continue;
        if (!useful.includes(candidate.href)) useful.push(candidate.href);
      } catch {
        // Ignore malformed links.
      }
      if (useful.length >= SECONDARY_PAGE_LIMIT) break;
    }

    const pages: WebsitePageEvidence[] = [home];
    for (const href of useful) {
      try {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(300);
        pages.push(await readRenderedPage(page, MAX_SECONDARY_TEXT));
      } catch {
        // Secondary pages are corroboration, never required.
      }
    }

    return {
      requestedUrl: url,
      finalUrl: home.url,
      rendered: true,
      pages,
      ...(screenshot
        ? { screenshotDataUrl: `data:image/jpeg;base64,${Buffer.from(screenshot).toString('base64')}` }
        : {}),
    };
  } catch (err) {
    const fallback = await fetchWebsite(url);
    if (fallback) {
      return {
        requestedUrl: url,
        rendered: false,
        pages: [
          {
            url,
            title: fallback.title,
            description: fallback.description,
            headings: fallback.headings,
            text: fallback.text,
            navigation: [],
            jsonLd: [],
          },
        ],
        error: `Rendered evidence unavailable: ${(err as Error).message}`,
      };
    }
    return {
      requestedUrl: url,
      rendered: false,
      pages: [],
      error: `Website evidence unavailable: ${(err as Error).message}`,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}