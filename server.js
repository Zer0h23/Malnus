const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function safeText(value = '') {
  return decodeHtmlEntities(
    String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function inferTenderCategory(title = '', priorityLabel = '') {
  const normalizedTitle = String(title).toLowerCase();

  if (priorityLabel) {
    return priorityLabel;
  }
  if (/(nato\s*diana|diana)/.test(normalizedTitle)) {
    return 'NATO DIANA';
  }
  if (/(cassini)/.test(normalizedTitle)) {
    return 'Cassini';
  }
  if (/(eic|european innovation council)/.test(normalizedTitle)) {
    return 'EIC';
  }
  if (/(horizon( europe)?)/.test(normalizedTitle)) {
    return 'Horizon';
  }
  if (/(eudis)/.test(normalizedTitle)) {
    return 'EUDIS';
  }
  if (/(esa|europe|eu)/.test(normalizedTitle)) {
    return 'ESA / Europe related';
  }
  if (/(space|satellite|orbital|launch|payload)/.test(normalizedTitle)) {
    return 'Space related';
  }
  if (/(localization|localisation|language|translation|linguistic)/.test(normalizedTitle)) {
    return 'Localization related';
  }
  if (/(geospatial|mapping|cartography|survey|gis)/.test(normalizedTitle)) {
    return 'Geospatial / mapping';
  }
  if (/(engineering|service|software)/.test(normalizedTitle)) {
    return 'Technical service opportunity';
  }

  return 'Public-sector opportunity';
}

function dedupeTenders(listings) {
  const seen = new Set();
  return listings.filter((item) => {
    const key = `${item.title}|${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function enrichTender(item) {
  const title = String(item.title || '');
  return {
    ...item,
    category: inferTenderCategory(title, item.priorityLabel || ''),
  };
}

const MALNUS_FIT_RULES = [
  { pattern: /nato\s*diana|diana/, weight: 15, reason: 'NATO DIANA priority programme' },
  { pattern: /eic|european innovation council/, weight: 15, reason: 'EIC priority programme' },
  { pattern: /horizon( europe)?/, weight: 15, reason: 'Horizon Europe priority programme' },
  { pattern: /cassini/, weight: 15, reason: 'Cassini priority programme' },
  { pattern: /eudis/, weight: 15, reason: 'EUDIS priority programme' },
  { pattern: /\bedf\b|european defence fund/, weight: 15, reason: 'EDF priority programme' },
  { pattern: /localization|localisation|translation|language|linguistic/, weight: 20, reason: 'Localization / language services match' },
  { pattern: /geospatial|mapping|cartography|\bgis\b|earth observation/, weight: 15, reason: 'Geospatial / mapping match' },
  { pattern: /space|satellite|orbital|payload/, weight: 15, reason: 'Space / satellite domain match' },
  { pattern: /defence|defense|security/, weight: 10, reason: 'Defence / security relevance' },
  { pattern: /engineering|software|technical service/, weight: 10, reason: 'Technical / engineering services match' },
  { pattern: /esa/, weight: 10, reason: 'ESA relevance' },
  { pattern: /europe|\beu\b/, weight: 5, reason: 'General EU relevance' },
];

function computeMalnusFitScore(item) {
  const title = String(item.title || '').toLowerCase();
  const description = String(item.description || '').toLowerCase();
  const combined = `${title} ${description}`;
  let score = 0;
  const matchedReasons = [];

  for (const rule of MALNUS_FIT_RULES) {
    if (rule.pattern.test(combined)) {
      score += rule.weight;
      matchedReasons.push(rule.reason);
    }
  }

  return { fitScore: Math.min(100, score), fitReasons: matchedReasons };
}

function fitLabelForScore(score) {
  if (score >= 70) return 'Strong fit';
  if (score >= 45) return 'Good fit';
  if (score >= 25) return 'Possible fit';
  return 'Weak fit';
}

function boostPriorityPrograms(listings) {
  return listings
    .map((item) => {
      const { fitScore, fitReasons } = computeMalnusFitScore(item);
      return { ...item, fitScore, fitLabel: fitLabelForScore(fitScore), fitReasons };
    })
    .sort((a, b) => b.fitScore - a.fitScore)
    .map(enrichTender);
}

function matchesKeyword(title = '', query = '') {
  const normalizedTitle = String(title).toLowerCase();
  const queryTerms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (!queryTerms.length) return true;
  return queryTerms.some((term) => normalizedTitle.includes(term));
}

function filterByKeywords(listings, query) {
  const filtered = listings.filter((item) => matchesKeyword(item.title, query));
  return filtered.length > 0 ? filtered : listings;
}

function isMALNUSEligible(title = '') {
  const normalizedTitle = String(title).toLowerCase();
  const eligibleKeywords = [
    'space',
    'satellite',
    'geospatial',
    'mapping',
    'cartography',
    'localization',
    'localisation',
    'translation',
    'language',
    'software',
    'engineering',
    'services',
    'data',
    'earth observation',
    'geo',
    'cassini',
    'horizon',
    'eic',
    'nato',
    'diana',
    'eudis',
    'innovation',
    'defence',
    'defense',
  ];

  return eligibleKeywords.some((keyword) => normalizedTitle.includes(keyword));
}

function filterByMALNUSEligibility(listings) {
  return listings.filter((item) => item.priorityLabel || isMALNUSEligible(item.title));
}

function extractRenderedEsaTenderLinks(keyword = '') {
  return new Promise(async (resolve, reject) => {
    let browser;

    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        locale: 'en-GB',
      });

      const targetUrl = keyword
        ? `https://esastar-publication-ext.sso.esa.int/ESATenderActions/filter/open?s=${encodeURIComponent(keyword)}`
        : 'https://esastar-publication-ext.sso.esa.int/ESATenderActions/filter/open';

      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await page.waitForTimeout(2500);

      const listings = await page.evaluate(() => {
        const seen = new Set();
        const items = [];
        const anchors = Array.from(document.querySelectorAll('a[href*="/ESATenderActions/details/"]'));

        anchors.forEach((anchor) => {
          const text = String(anchor.textContent || '').replace(/\s+/g, ' ').trim();
          const href = String(anchor.href || '').trim();

          if (!href || !text || text.length < 8 || /^[\d\s-]+$/.test(text)) {
            return;
          }

          const key = `${text}|${href}`;
          if (seen.has(key)) {
            return;
          }

          seen.add(key);
          items.push({ title: text, url: href, source: 'ESA STAR' });
        });

        return items;
      });

      resolve(listings.slice(0, 25));
    } catch (error) {
      reject(error);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  });
}

async function fetchEsaSearch(query, limit = 10) {
  const [openListings, cassiniListings] = await Promise.all([
    extractRenderedEsaTenderLinks(),
    extractRenderedEsaTenderLinks('cassini'),
  ]);

  const cassiniTagged = cassiniListings.map((item) => ({
    ...item,
    priorityLabel: /horizon( europe)?/i.test(item.title) ? 'Horizon Europe' : 'Cassini',
  }));
  const merged = dedupeTenders([...cassiniTagged, ...openListings]);
  const eligible = filterByMALNUSEligibility(merged);
  const filtered = filterByKeywords(eligible, query);

  return boostPriorityPrograms(filtered).slice(0, limit);
}

const EIC_FUNDING_URL = 'https://eic.ec.europa.eu/eic-funding-opportunities_en';
const EIC_BASE_URL = 'https://eic.ec.europa.eu/';

function toAbsoluteEicUrl(href = '') {
  try {
    return new URL(href, EIC_BASE_URL).href;
  } catch (error) {
    return href;
  }
}

function eicPriorityLabel(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  return /horizon/.test(combined) ? 'Horizon Europe' : 'EIC';
}

async function extractEicListings() {
  let html;
  try {
    const response = await fetch(EIC_FUNDING_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!response.ok) {
      throw new Error(`EIC site responded with ${response.status}`);
    }
    html = await response.text();
  } catch (error) {
    return [];
  }

  const items = [];
  const seen = new Set();

  const addItem = (title, href, description) => {
    const cleanTitle = safeText(title);
    const cleanDescription = safeText(description);
    const absoluteUrl = toAbsoluteEicUrl(href);

    if (!cleanTitle || !absoluteUrl) return;

    const key = `${cleanTitle}|${absoluteUrl}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      title: cleanTitle,
      url: absoluteUrl,
      source: 'EIC Funding Opportunities',
      description: cleanDescription,
      priorityLabel: eicPriorityLabel(cleanTitle, cleanDescription),
    });
  };

  const tileRegex = /ecl-list-illustration__title">([^<]+)<\/div><\/div><div class="ecl-list-illustration__description"><div class="ecl"><p>([^<]*)<\/p><p><a href="([^"]+)"/g;
  let match;
  while ((match = tileRegex.exec(html)) !== null) {
    addItem(match[1], match[3], match[2]);
  }

  const callRegex = /ecl-label--high"\s*>([^<]*)<\/span><\/div><\/div><div class="ecl-content-block__title"><a\s+href="([^"]+)"[^>]*>([^<]*)<\/a><\/div><div class="ecl-content-block__description">([\s\S]*?)<\/div>/g;
  while ((match = callRegex.exec(html)) !== null) {
    const [, , href, title, descriptionHtml] = match;
    addItem(title, href, descriptionHtml);
  }

  return items;
}

async function fetchEicSearch(query, limit = 10) {
  let listings;
  try {
    listings = await extractEicListings();
  } catch (error) {
    return [];
  }

  const filtered = filterByKeywords(listings, query);
  return boostPriorityPrograms(filtered).slice(0, limit);
}

const EU_PORTAL_SEARCH_URL = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search';
const EU_PORTAL_STATUS_FORTHCOMING = '31094501';
const EU_PORTAL_STATUS_OPEN = '31094502';

function toOrQuery(query = '') {
  const terms = String(query).match(/"[^"]+"|\S+/g) || [];
  return terms.join(' OR ');
}

function euPortalProgrammeLabel(identifier = '', title = '') {
  const normalizedId = String(identifier).toUpperCase();
  const normalizedTitle = String(title).toLowerCase();

  if (/^HORIZON/.test(normalizedId)) return 'Horizon Europe';
  if (/^EDF/.test(normalizedId)) return 'EDF';
  if (/^EIC/.test(normalizedId) || /european innovation council/.test(normalizedTitle)) return 'EIC';
  if (/cassini/.test(normalizedTitle)) return 'Cassini';
  return '';
}

function buildEuPortalRequestBody(boundary) {
  const query = JSON.stringify({
    bool: {
      must: [
        { terms: { type: ['1', '2', '8'] } },
        { terms: { status: [EU_PORTAL_STATUS_FORTHCOMING, EU_PORTAL_STATUS_OPEN] } },
        { terms: { DATASOURCE: ['SEDIA'] } },
        { terms: { language: ['en'] } },
      ],
    },
  });

  const displayFields = JSON.stringify([
    'type',
    'identifier',
    'reference',
    'callccm2Id',
    'title',
    'status',
    'startDate',
    'deadlineDate',
    'deadlineModel',
    'frameworkProgramme',
    'typesOfAction',
  ]);

  const parts = [
    { name: 'query', value: query },
    { name: 'languages', value: '["en"]' },
    { name: 'displayFields', value: displayFields },
  ];

  return (
    parts
      .map(
        (part) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="blob"\r\nContent-Type: application/json\r\n\r\n${part.value}\r\n`
      )
      .join('') + `--${boundary}--\r\n`
  );
}

async function fetchEuPortalCalls(query, limit = 20) {
  const boundary = `----TenderHunter${Date.now()}`;
  const params = new URLSearchParams({
    apiKey: 'SEDIA',
    text: toOrQuery(query),
    pageSize: String(Math.min(Math.max(limit * 3, 20), 50)),
    pageNumber: '1',
  });

  let json;
  try {
    const response = await fetch(`${EU_PORTAL_SEARCH_URL}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: buildEuPortalRequestBody(boundary),
    });
    if (!response.ok) {
      throw new Error(`EU portal responded with ${response.status}`);
    }
    json = await response.json();
  } catch (error) {
    return [];
  }

  const items = (json.results || [])
    .map((result) => {
      const metadata = result.metadata || {};
      const identifier = metadata.identifier?.[0] || '';
      const title = safeText(metadata.title?.[0] || result.summary || '');
      const status = metadata.status?.[0] === EU_PORTAL_STATUS_OPEN ? 'Open' : 'Forthcoming';
      const deadlineRaw = metadata.deadlineDate?.[0];
      const deadline = deadlineRaw ? new Date(deadlineRaw).toISOString().slice(0, 10) : '';
      const priorityLabel = euPortalProgrammeLabel(identifier, title);

      if (!title || !result.url) return null;

      return {
        title: identifier ? `${identifier} — ${title}` : title,
        url: result.url,
        source: 'EU Funding & Tenders Portal',
        description: `Status: ${status}.${deadline ? ` Deadline: ${deadline}.` : ''}`,
        ...(priorityLabel ? { priorityLabel } : {}),
      };
    })
    .filter(Boolean);

  return dedupeTenders(items).slice(0, limit);
}

async function fetchTenderSearch(query, country = 'Europe', limit = 10) {
  const normalizedQuery = (query || 'space localization geospatial satellite ESA').trim() || 'space localization geospatial satellite ESA';

  const [esaResults, eicResults, euPortalResults] = await Promise.all([
    fetchEsaSearch(normalizedQuery, limit),
    fetchEicSearch(normalizedQuery, limit),
    fetchEuPortalCalls(normalizedQuery, limit),
  ]);

  const eligibleEuPortalResults = filterByMALNUSEligibility(euPortalResults);
  const combined = dedupeTenders([...esaResults, ...eicResults, ...eligibleEuPortalResults]);
  return boostPriorityPrograms(combined).slice(0, limit);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/tenders') {
    const query = (url.searchParams.get('query') || 'space localization ESA').trim();
    const country = (url.searchParams.get('country') || 'Europe').trim();
    const limit = Math.min(Number(url.searchParams.get('limit') || 8), 50);

    try {
      const tenders = await fetchTenderSearch(query, country, limit);
      return sendJson(res, 200, { query, country, count: tenders.length, results: tenders });
    } catch (error) {
      return sendJson(res, 500, { error: error.message || 'Unable to fetch tenders right now.' });
    }
  }

  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(path.join(ROOT, filePath));

  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': getContentType(safePath) });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Tender Hunter MVP running at http://localhost:${PORT}`);
});
