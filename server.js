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
  {
    pattern: /nato\s*diana|diana/,
    weight: 15,
    reason: 'NATO DIANA priority programme',
    explanation:
      "It sits under NATO DIANA, the transatlantic dual-use accelerator that is one of Malnus's explicitly named target programmes, so the funding route itself is already a strategic fit, not just the subject matter.",
  },
  {
    pattern: /eic|european innovation council/,
    weight: 15,
    reason: 'EIC priority programme',
    explanation:
      "It runs through the European Innovation Council, which Malnus tracks as a core funding channel for scaling deep-tech and dual-use innovation, so simply being an EIC call raises its relevance regardless of topic.",
  },
  {
    pattern: /horizon( europe)?/,
    weight: 15,
    reason: 'Horizon Europe priority programme',
    explanation:
      "It's funded under Horizon Europe, the EU's flagship R&I programme and one of the funding sources Malnus actively monitors, which means the application process and eligibility rules are ones the team already understands.",
  },
  {
    pattern: /cassini/,
    weight: 15,
    reason: 'Cassini priority programme',
    explanation:
      "It falls under the Cassini initiative for space downstream and NewSpace ventures, a named priority programme for Malnus, so it directly targets the segment of the space economy the company is positioned in.",
  },
  {
    pattern: /eudis/,
    weight: 15,
    reason: 'EUDIS priority programme',
    explanation:
      "It's issued through EUDIS, the European Defence Innovation Scheme, matching Malnus's interest in EU-backed defence-innovation funding specifically (as opposed to general research funding).",
  },
  {
    pattern: /\bedf\b|european defence fund/,
    weight: 15,
    reason: 'EDF priority programme',
    explanation:
      "It's funded by the European Defence Fund, which aligns with Malnus's interest in EU defence-technology funding and typically comes with fewer commercial-market competitors than open Horizon Europe calls.",
  },
  {
    pattern: /localization|localisation|translation|language|linguistic/,
    weight: 20,
    reason: 'Localization / language services match',
    explanation:
      "The scope explicitly calls for localization, translation, or language services — this is Malnus's own service line, so the company wouldn't just be eligible to bid, it would likely be delivering exactly what it already sells.",
  },
  {
    pattern: /geospatial|mapping|cartography|\bgis\b|earth observation/,
    weight: 15,
    reason: 'Geospatial / mapping match',
    explanation:
      "It involves geospatial data, mapping, or earth-observation work, which lines up with Malnus's GIS capabilities and means existing tooling and expertise could carry directly into the proposal.",
  },
  {
    pattern: /space|satellite|orbital|payload/,
    weight: 15,
    reason: 'Space / satellite domain match',
    explanation:
      "It's a space or satellite-systems opportunity, squarely inside Malnus's aerospace engineering focus rather than an adjacent or general-purpose technical field.",
  },
  {
    pattern: /defence|defense|security/,
    weight: 10,
    reason: 'Defence / security relevance',
    explanation:
      "It has a defence or security angle, relevant if Malnus wants to lean further into dual-use / defence-oriented contracts rather than purely civilian ones.",
  },
  {
    pattern: /engineering|software|technical service/,
    weight: 10,
    reason: 'Technical / engineering services match',
    explanation:
      "It requires engineering or software/technical services delivery, which is a general capability match even where the specific domain isn't Malnus's narrowest niche.",
  },
  {
    pattern: /esa/,
    weight: 10,
    reason: 'ESA relevance',
    explanation:
      "It's issued via ESA — a procurement channel Malnus already actively tracks — so the buyer relationship and bidding process are familiar rather than a cold start.",
  },
  {
    pattern: /europe|\beu\b/,
    weight: 5,
    reason: 'General EU relevance',
    explanation:
      "It's a broader EU-funded opportunity, which mainly extends eligibility rather than indicating a strong thematic match on its own.",
  },
];

function computeMalnusFitScore(item) {
  const title = String(item.title || '').toLowerCase();
  const description = String(item.description || '').toLowerCase();
  const combined = `${title} ${description}`;
  let score = 0;
  const matchedRules = [];

  for (const rule of MALNUS_FIT_RULES) {
    if (rule.pattern.test(combined)) {
      score += rule.weight;
      matchedRules.push(rule);
    }
  }

  return { fitScore: Math.min(100, score), matchedRules };
}

function fitLabelForScore(score) {
  if (score >= 70) return 'Strong fit';
  if (score >= 45) return 'Good fit';
  if (score >= 25) return 'Possible fit';
  return 'Weak fit';
}

function buildFitSummary(item, fitScore, label, matchedRules) {
  if (!matchedRules.length) {
    return "No strong overlap detected with Malnus s.r.o.'s core focus areas (space, satellite, geospatial, localization, ESA/EU programmes). It only surfaced because it cleared the general eligibility keyword filter, so treat it as a long shot worth a manual skim rather than a targeted match.";
  }

  const ranked = [...matchedRules].sort((a, b) => b.weight - a.weight);
  const primary = ranked.slice(0, 3);
  const rest = ranked.slice(3);

  const openers = {
    'Strong fit': `This is a strong match (${fitScore}%) for Malnus s.r.o.`,
    'Good fit': `This is a good match (${fitScore}%) for Malnus s.r.o.`,
    'Possible fit': `This is a possible match (${fitScore}%) for Malnus s.r.o.`,
    'Weak fit': `This is only a weak match (${fitScore}%) for Malnus s.r.o.`,
  };

  const sentences = [openers[label] || `Fit score: ${fitScore}%.`, ...primary.map((rule) => rule.explanation)];

  if (rest.length) {
    sentences.push(`It also touches on ${rest.map((rule) => rule.reason.replace(/ priority programme$/, '').toLowerCase()).join(', ')}, which nudges the score up further without being the main driver.`);
  }

  const extras = [];
  if (item.fundingAmount) extras.push(`the indicative funding is ${item.fundingAmount}`);
  if (item.deadline) extras.push(`the deadline is ${item.deadline}`);
  if (extras.length) {
    sentences.push(`Worth noting: ${extras.join(', and ')}.`);
  }

  return sentences.join(' ');
}

function boostPriorityPrograms(listings) {
  return listings
    .map((item) => {
      const { fitScore, matchedRules } = computeMalnusFitScore(item);
      const fitLabel = fitLabelForScore(fitScore);
      const fitReasons = matchedRules.map((rule) => rule.reason);
      return {
        ...item,
        fitScore,
        fitLabel,
        fitReasons,
        fitSummary: buildFitSummary(item, fitScore, fitLabel, matchedRules),
      };
    })
    .sort((a, b) => b.fitScore - a.fitScore)
    .map(enrichTender);
}

function pickNextDeadlineIso(isoDates = []) {
  const valid = [...new Set(isoDates.filter(Boolean))].sort();
  if (!valid.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  return valid.find((date) => date >= today) || valid[valid.length - 1];
}

function parseDdMmYyyy(raw = '') {
  const match = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function extractDottedDates(text = '') {
  const matches = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g) || [];
  return matches.map((raw) => {
    const [d, mo, y] = raw.split('.');
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  });
}

function extractEuroAmounts(text = '') {
  const matches = text.match(/€\s?[\d.,]+\s*(?:thousand|million|billion)?/gi) || [];
  return [...new Set(matches.map((m) => m.replace(/\s+/g, ' ').trim()))];
}

function formatEurAmount(value) {
  if (!Number.isFinite(value)) return '';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `€${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `€${Math.round(value / 1_000)}K`;
  return `€${value}`;
}

function formatEurRange(min, max) {
  if (min && max && min !== max) return `${formatEurAmount(min)} – ${formatEurAmount(max)} per grant`;
  if (max) return `up to ${formatEurAmount(max)} per grant`;
  if (min) return `from ${formatEurAmount(min)} per grant`;
  return '';
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

          const card = anchor.closest('.card-body');
          const rightColText = card ? card.querySelector('.col-right')?.innerText || '' : '';
          const closingMatch = rightColText.match(/Closing Date:\s*([\d/]+)/);

          items.push({ title: text, url: href, source: 'ESA STAR', closingDateRaw: closingMatch ? closingMatch[1] : '' });
        });

        return items;
      });

      resolve(
        listings.slice(0, 25).map(({ closingDateRaw, ...item }) => ({
          ...item,
          deadline: parseDdMmYyyy(closingDateRaw),
        }))
      );
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

    const euroAmounts = extractEuroAmounts(cleanDescription);

    items.push({
      title: cleanTitle,
      url: absoluteUrl,
      source: 'EIC Funding Opportunities',
      description: cleanDescription,
      priorityLabel: eicPriorityLabel(cleanTitle, cleanDescription),
      deadline: pickNextDeadlineIso(extractDottedDates(cleanDescription)),
      fundingAmount: euroAmounts.length ? euroAmounts.join(', ') : '',
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
    'budgetOverview',
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

function findBudgetEntryForIdentifier(budgetOverviewRaw, identifier) {
  if (!budgetOverviewRaw || !identifier) return null;

  let parsed;
  try {
    parsed = JSON.parse(budgetOverviewRaw);
  } catch (error) {
    return null;
  }

  const actionMap = parsed.budgetTopicActionMap || {};
  for (const entries of Object.values(actionMap)) {
    for (const entry of entries) {
      if (String(entry.action || '').startsWith(identifier)) {
        return entry;
      }
    }
  }

  return null;
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
      const deadline = deadlineRaw ? new Date(deadlineRaw).toISOString().slice(0, 10) : null;
      const priorityLabel = euPortalProgrammeLabel(identifier, title);

      const budgetEntry = findBudgetEntryForIdentifier(metadata.budgetOverview?.[0], identifier);
      const fundingAmount = budgetEntry
        ? `${formatEurRange(budgetEntry.minContribution, budgetEntry.maxContribution)}${
            budgetEntry.expectedGrants ? ` (~${budgetEntry.expectedGrants} grant${budgetEntry.expectedGrants === 1 ? '' : 's'} expected)` : ''
          }`
        : '';

      if (!title || !result.url) return null;

      return {
        title: identifier ? `${identifier} — ${title}` : title,
        url: result.url,
        source: 'EU Funding & Tenders Portal',
        description: `Status: ${status}.${deadline ? ` Deadline: ${deadline}.` : ''}`,
        deadline,
        fundingAmount,
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
