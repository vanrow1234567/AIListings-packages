import type { AuditRequest, ChatGptResponse } from '../../src/domain/types.ts';
import type { WebsiteSnapshot } from '../../src/business/understand.ts';

/**
 * LS-Tiling (Wendover) regression fixture.
 *
 * Reconstructed from the reported live audit of 2026-09-04: the prospect's name was not
 * visible in any layer, ChatGPT surfaced Limartra Tiling and Restoration, SDB Tiling and
 * Signature Tiling & Carpentry in the Conversational layer, and a map card carried
 * Mapbox / OpenStreetMap attribution links. The rendered structure (bold names, list
 * items, headings, map attribution anchors, citation chips, tracking query strings)
 * mirrors what chatgpt.com displays; the exact prose is representative. Drop the real
 * captured audit JSON into test/fixtures/live/ to run the same assertions against it.
 */
export const LS_TILING: AuditRequest = {
  business_name: 'LS-Tiling',
  website: 'https://ls-tiling.co.uk',
  location: 'Wendover',
};

export const lsTilingSite: WebsiteSnapshot = {
  title: 'LS-Tiling | Wall and Floor Tiling in Wendover and Aylesbury',
  description: 'Professional tiler covering Wendover, Aylesbury and the Chilterns.',
  headings: ['Tiling Services'],
  text: 'LS-Tiling offers wall and floor tiling, bathrooms and kitchens.',
};

const MAP_CARD =
  '<div class="map-card"><h4>Wendover, Buckinghamshire</h4>' +
  '<div class="place"><strong>SDB Tiling</strong><div><b>Pound Street, Wendover</b></div><span>4.9 ★ (37 reviews)</span></div>' +
  '<div class="place"><strong>Signature Tiling &amp; Carpentry</strong><div><b>London Road, Wendover</b></div><span>5.0 ★ (12 reviews)</span></div>' +
  '<div class="mapboxgl-map"><div class="mapboxgl-ctrl-attrib">' +
  '<a href="https://www.mapbox.com/about/maps/" target="_blank">© Mapbox</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap</a> ' +
  '<a href="https://apps.mapbox.com/feedback/?owner=openai&amp;id=xyz" target="_blank">Improve this map</a>' +
  '</div></div>' +
  '<a href="https://www.google.com/maps/search/tilers+near+Wendover/?utm_source=chatgpt.com">Open in Google Maps</a></div>';

const MAP_TEXT =
  'Wendover, Buckinghamshire\nSDB Tiling\nPound Street, Wendover\n4.9 ★ (37 reviews)\nSignature Tiling & Carpentry\nLondon Road, Wendover\n5.0 ★ (12 reviews)\n' +
  '© Mapbox © OpenStreetMap Improve this map\nOpen in Google Maps';

/** Advice block ChatGPT appends to Conversational answers: instructions and section headings, not businesses. */
const ADVICE_HTML =
  '<h3>How to choose</h3><ol>' +
  '<li><p><strong>Work out exactly what needs tiling</strong> – walls, floor or both, and the area in m².</p></li>' +
  '<li><p><strong>Get 2–3 quotes</strong> – ask each tiler to itemise labour and materials.</p></li>' +
  '<li><p><strong>Check reviews and insurance</strong> – public liability at a minimum.</p></li></ol>' +
  '<h3>For tiles themselves</h3><p>Tile retailers in Aylesbury and online suppliers are the usual options.</p>';
const ADVICE_TEXT =
  'How to choose\nWork out exactly what needs tiling – walls, floor or both, and the area in m².\nGet 2–3 quotes – ask each tiler to itemise labour and materials.\n' +
  'Check reviews and insurance – public liability at a minimum.\nFor tiles themselves\nTile retailers in Aylesbury and online suppliers are the usual options.';

/** VISIBLE: "Tiling companies in Wendover" */
export const visibleResponse: ChatGptResponse = {
  text:
    'Here are some tiling companies serving Wendover and the surrounding area:\n' +
    'SDB Tiling – wall and floor tiling, Aylesbury and Wendover.\n' +
    'Limartra Tiling and Restoration – natural stone and tile restoration specialists.\n' +
    'Signature Tiling & Carpentry – bathrooms and kitchens across Bucks.\n' +
    'Tiling\n' +
    'You can also check Checkatrade or Rated People for reviewed local tilers.\n' +
    MAP_TEXT,
  html:
    '<p>Here are some tiling companies serving Wendover and the surrounding area:</p><ul>' +
    '<li><p><strong>SDB Tiling</strong> – wall and floor tiling, Aylesbury and Wendover. <a href="https://www.sdbtiling.co.uk/?utm_source=chatgpt.com">sdbtiling.co.uk</a></p></li>' +
    '<li><p><strong>Limartra Tiling and Restoration</strong> – natural stone and tile restoration specialists.</p></li>' +
    '<li><p><strong>Signature Tiling &amp; Carpentry</strong> – bathrooms and kitchens across Bucks.</p></li></ul>' +
    '<h3>Tiling</h3>' +
    '<p>You can also check <a href="https://www.checkatrade.com/trades/tilers/wendover">Checkatrade</a> or <a href="https://www.ratedpeople.com/">Rated People</a> for reviewed local tilers.</p>' +
    MAP_CARD,
  links: [
    'https://www.sdbtiling.co.uk/?utm_source=chatgpt.com',
    'https://www.checkatrade.com/trades/tilers/wendover',
    'https://www.ratedpeople.com/',
    'https://www.mapbox.com/about/maps/',
    'https://www.openstreetmap.org/copyright',
    'https://apps.mapbox.com/feedback/?owner=openai&id=xyz',
    'https://www.google.com/maps/search/tilers+near+Wendover/?utm_source=chatgpt.com',
    'https://chatgpt.com/?temporary-chat=true',
  ],
};

/** RECOMMENDED: "Who would you recommend for help with tiling in Wendover?" */
export const recommendedResponse: ChatGptResponse = {
  text:
    "I can't vouch for individual tradespeople, but these tilers come up well for the Wendover area:\n" +
    'Limartra Tiling and Restoration – strong reviews for stone and porcelain work.\n' +
    'Signature Tiling & Carpentry – good for full bathroom refits.\n' +
    'Tiler recommendations\n' +
    'Ask for a written quote, proof of insurance and photos of recent tiling work.\n' +
    MAP_TEXT,
  html:
    "<p>I can't vouch for individual tradespeople, but these tilers come up well for the Wendover area:</p><ul>" +
    '<li><p><strong>Limartra Tiling and Restoration</strong> – strong reviews for stone and porcelain work.</p></li>' +
    '<li><p><strong>Signature Tiling &amp; Carpentry</strong> – good for full bathroom refits.</p></li></ul>' +
    '<h3>Tiler recommendations</h3>' +
    '<p>Ask for a written quote, proof of insurance and photos of recent tiling work.</p>' +
    MAP_CARD,
  links: [
    'https://www.mapbox.com/about/maps/',
    'https://www.openstreetmap.org/copyright',
    'https://www.google.com/maps/search/tilers+near+Wendover/?utm_source=chatgpt.com',
    'https://openai.com/policies',
  ],
};

/** CONVERSATIONAL turn 1: the problem description. */
export const conversationalTurn1: ChatGptResponse = {
  text:
    'Loose or cracked tiles usually mean the adhesive has failed or the substrate has moved. A tiler can lift the affected area, ' +
    'check the boards behind and re-tile it in a day or two. Tiling like this is a repair job, not a full refit.\n' +
    ADVICE_TEXT +
    '\nWould you like me to suggest some tilers near Wendover?',
  html:
    '<p>Loose or cracked tiles usually mean the adhesive has failed or the substrate has moved. A tiler can lift the affected area, ' +
    'check the boards behind and re-tile it in a day or two. <strong>Tiling</strong> like this is a repair job, not a full refit.</p>' +
    ADVICE_HTML +
    '<p>Would you like me to suggest some tilers near Wendover?</p>',
  links: [],
};

/** CONVERSATIONAL turn 2: "Yes please. Who would you recommend I speak to?" */
export const conversationalTurn2: ChatGptResponse = {
  text:
    'Here are a few tilers near Wendover worth contacting:\n' +
    'Limartra Tiling and Restoration – Aylesbury; stone, porcelain and repairs.\n' +
    'SDB Tiling – Wendover and Aylesbury; wall and floor tiling.\n' +
    'Signature Tiling & Carpentry – Chesham; bathrooms and kitchens.\n' +
    'Local tilers\n' +
    'Tiling\n' +
    MAP_TEXT +
    '\n' + ADVICE_TEXT +
    '\nSources',
  html:
    '<p>Here are a few tilers near Wendover worth contacting:</p><ul>' +
    '<li><p><strong>Limartra Tiling and Restoration</strong> – Aylesbury; stone, porcelain and repairs.</p></li>' +
    '<li><p><strong>SDB Tiling</strong> – Wendover and Aylesbury; wall and floor tiling.</p></li>' +
    '<li><p><strong>Signature Tiling &amp; Carpentry</strong> – Chesham; bathrooms and kitchens.</p></li></ul>' +
    '<h3>Local tilers</h3><h4>Tiling</h4>' +
    MAP_CARD + ADVICE_HTML +
    '<div class="sources"><a href="https://www.mapbox.com/">Sources</a></div>',
  links: [
    'https://www.mapbox.com/about/maps/',
    'https://www.openstreetmap.org/copyright',
    'https://apps.mapbox.com/feedback/?owner=openai&id=xyz',
    'https://www.google.com/maps/search/tilers+near+Wendover/?utm_source=chatgpt.com',
    'https://www.mapbox.com/',
  ],
};
