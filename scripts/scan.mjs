import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const root = new URL('../', import.meta.url);
const cfg = JSON.parse(await fs.readFile(new URL('config.json', root), 'utf8'));
const apiKey = process.env.SERPER_API_KEY;

if (!apiKey) {
  console.error('Missing SERPER_API_KEY.');
  process.exit(2);
}

const titleBad = /(salvage|rebuilt|reconstructed|flood|junk|parts only|certificate of destruction|lemon buyback)/i;
const mediumRisk = /(accident|damage|lien|title issue|insurance loss|total loss)/i;
const dealerWords = /(dealership|dealer price|financing available|buy here pay here|monthly payment|dealer fee)/i;
const privateWords = /(private seller|by owner|owner sale|one owner selling|selling my|my vehicle|my suv)/i;
const seatWords = /(7\s*(?:passenger|seat)|8\s*(?:passenger|seat)|third row|3rd row|three row)/i;

const modelPatterns = [
  ['Toyota Highlander', /\bhighlander\b/i],
  ['Honda Pilot', /\bpilot\b/i],
  ['Mazda CX-9', /\bcx[- ]?9\b/i],
  ['Acura MDX', /\bmdx\b/i],
  ['Ford Explorer', /\bexplorer\b/i],
  ['Hyundai Santa Fe XL', /\bsanta fe xl\b/i],
  ['Kia Sorento', /\bsorento\b/i],
  ['Chevrolet Traverse', /\btraverse\b/i],
  ['GMC Acadia', /\bacadia\b/i],
  ['Dodge Durango', /\bdurango\b/i],
  ['Nissan Pathfinder', /\bpathfinder\b/i],
  ['Buick Enclave', /\benclave\b/i],
  ['Infiniti QX60', /\b(qx60|jx35)\b/i],
  ['Toyota 4Runner', /\b4runner\b/i]
];

function numberOnly(v) {
  if (!v) return null;
  return Number(String(v).replace(/[^0-9]/g, '')) || null;
}

function sourceFromUrl(url='') {
  const u = url.toLowerCase();
  if (u.includes('craigslist.org')) return 'Craigslist';
  if (u.includes('facebook.com/marketplace')) return 'Facebook Marketplace';
  if (u.includes('privateauto.com')) return 'PrivateAuto';
  if (u.includes('ebay.com')) return 'eBay Motors';
  if (u.includes('cars.com')) return 'Cars.com';
  if (u.includes('offerup.com')) return 'OfferUp';
  if (u.includes('autotrader.com')) return 'Autotrader';
  if (u.includes('cargurus.com')) return 'CarGurus';
  if (u.includes('truecar.com')) return 'TrueCar';
  return 'Web';
}

function extractModel(text) {
  for (const [name, re] of modelPatterns) if (re.test(text)) return name;
  return null;
}

function parse(item, region) {
  const title = item.title || '';
  const snippet = item.snippet || '';
  const text = title + ' ' + snippet;
  const url = item.link || '';
  const source = sourceFromUrl(url);

  const priceMatches = [...text.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})/g)]
    .map(m => numberOnly(m[1]))
    .filter(n => n >= 2000 && n <= 100000);
  const price = priceMatches.length ? Math.min(...priceMatches) : null;

  const yearMatch = text.match(/\b(20[0-2][0-9]|19[89][0-9])\b/);
  const year = numberOnly(yearMatch?.[1]);

  const mileageMatch = text.match(/\b([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:mi|miles|mile)\b/i)
    || text.match(/\b([0-9]{2,3})k\s*(?:mi|miles)?\b/i);
  let mileage = null;
  if (mileageMatch) {
    mileage = /k/i.test(mileageMatch[0]) ? numberOnly(mileageMatch[1]) * 1000 : numberOnly(mileageMatch[1]);
  }

  const model = extractModel(text);
  const privateSource = ['Craigslist', 'Facebook Marketplace', 'PrivateAuto', 'OfferUp'].includes(source);
  const privateSellerLikely = (privateSource || privateWords.test(text)) && !dealerWords.test(text);
  const dealerLikely = dealerWords.test(text) || ['Cars.com', 'Autotrader', 'CarGurus', 'TrueCar'].includes(source);
  const titleRisk = titleBad.test(text) ? 'high' : mediumRisk.test(text) ? 'medium' : 'unknown';
  const sevenSeatSignal = seatWords.test(text) || Boolean(model);

  let score = 42;
  const reasons = [];

  if (price !== null) {
    if (price <= cfg.maxPrice) {
      score += 18;
      reasons.push('Within $15k budget');
      if (price <= 13500) {
        score += 4;
        reasons.push('Leaves room for tax/repairs');
      }
    } else if (price <= cfg.maxPrice * 1.08) {
      score -= 4;
      reasons.push('Slightly above budget - may be negotiable');
    } else {
      score -= 24;
      reasons.push('Over budget');
    }
  } else {
    reasons.push('Price needs verification');
  }

  if (year !== null) {
    if (year >= cfg.minYear) {
      score += 14;
      reasons.push('Year fits configured Uber age screen');
    } else {
      score -= 25;
      reasons.push('Below configured year target');
    }
  } else {
    reasons.push('Year needs verification');
  }

  if (mileage !== null) {
    if (mileage <= 120000) {
      score += 11;
      reasons.push('Good mileage for budget');
    } else if (mileage <= cfg.maxMileage) {
      score += 5;
      reasons.push('Mileage within target');
    } else {
      score -= 12;
      reasons.push('High mileage');
    }
  }

  if (privateSellerLikely) {
    score += 12;
    reasons.push('Private seller likely');
  } else if (dealerLikely) {
    score -= 7;
    reasons.push('Dealer likely');
  }

  if (model) {
    score += 10;
    reasons.push('Preferred 7-seat SUV model');
  }

  if (sevenSeatSignal) {
    score += 5;
    reasons.push('7-seat / third-row signal');
  }

  if (titleRisk === 'high') {
    score -= 45;
    reasons.push('Salvage/rebuilt/flood warning');
  } else if (titleRisk === 'medium') {
    score -= 12;
    reasons.push('History/title wording needs review');
  }

  score = Math.max(0, Math.min(100, score));

  return {
    id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 14),
    title,
    url,
    snippet,
    source,
    location: region,
    model,
    price,
    year,
    mileage,
    privateSellerLikely,
    dealerLikely,
    titleRisk,
    uberXL: sevenSeatSignal && year && year >= cfg.minYear && titleRisk !== 'high' ? 'likely' : 'verify',
    score,
    reasons,
    foundAt: new Date().toISOString()
  };
}

async function search(q) {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ q, num: 20, gl: 'us', hl: 'en' })
  });
  if (!response.ok) throw new Error('Serper ' + response.status);
  return response.json();
}

const domainGroup = '(site:craigslist.org OR site:facebook.com/marketplace OR site:privateauto.com OR site:offerup.com OR site:ebay.com OR site:cars.com)';
const modelGroupA = '("Toyota Highlander" OR "Honda Pilot" OR "Mazda CX-9" OR "Ford Explorer" OR "Kia Sorento" OR "Chevrolet Traverse")';
const modelGroupB = '("Acura MDX" OR "GMC Acadia" OR "Dodge Durango" OR "Nissan Pathfinder" OR "Buick Enclave" OR "Infiniti QX60" OR "Toyota 4Runner")';

const all = [];
const queryLog = [];

for (const region of cfg.regions) {
  const queries = [
    `${domainGroup} ${modelGroupA} "${region}" used for sale`,
    `${domainGroup} ${modelGroupB} "${region}" used for sale`,
    `${domainGroup} "${region}" ("7 passenger" OR "8 passenger" OR "third row" OR "3rd row") SUV for sale`
  ];

  for (const q of queries) {
    try {
      const result = await search(q);
      const organic = result.organic || [];
      queryLog.push({ region, query: q, results: organic.length });
      for (const item of organic) {
        if (!item.link) continue;
        all.push(parse(item, region));
      }
      await new Promise(r => setTimeout(r, 250));
    } catch (error) {
      queryLog.push({ region, query: q, error: error.message });
      console.error(region, error.message);
    }
  }
}

const deduped = [...new Map(all.map(x => [x.url, x])).values()];

const filtered = deduped
  .filter(x => {
    if (x.titleRisk === 'high') return true; // keep visible so user can explicitly reject it
    if (x.price !== null && x.price > cfg.maxPrice * 1.08) return false;
    if (x.year !== null && x.year < cfg.minYear - 1) return false;
    return true;
  })
  .sort((a, b) => {
    if (a.privateSellerLikely !== b.privateSellerLikely) return a.privateSellerLikely ? -1 : 1;
    return b.score - a.score;
  })
  .slice(0, 250);

await fs.writeFile(new URL('data/listings.json', root), JSON.stringify(filtered, null, 2));
await fs.writeFile(
  new URL('data/scan-meta.json', root),
  JSON.stringify({
    lastScan: new Date().toISOString(),
    status: 'ok',
    count: filtered.length,
    rawCount: all.length,
    uniqueCount: deduped.length,
    queriesRun: queryLog.length,
    queryLog
  }, null, 2)
);

console.log('Raw results:', all.length);
console.log('Unique URLs:', deduped.length);
console.log('Saved listings:', filtered.length);
