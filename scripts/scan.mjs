import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const root=new URL('../',import.meta.url);
const cfg=JSON.parse(await fs.readFile(new URL('config.json',root),'utf8'));
const apiKey=process.env.SERPER_API_KEY;
if(!apiKey)throw Error('Missing SERPER_API_KEY');
const sites=['cars.com/vehicledetail','autotrader.com/cars-for-sale/vehicle','truecar.com/used-cars-for-sale/listing','cargurus.com/Cars'];
const models=[{name:'Toyota Sienna XLE',re:/\\bToyota\\s+Sienna\\b[\\s\\S]{0,40}\\bXLE\\b/i},{name:'Toyota RAV4 XLE',re:/\\bToyota\\s+RAV4\\b[\\s\\S]{0,40}\\bXLE\\b/i}];
const areas=['New York','Long Island','New Jersey','Connecticut'];
const results=[],errors=[],seen=new Set();
const digits=s=>Number(String(s||'').replace(/[^0-9]/g,''))||null;
const vinRe=/\\b[A-HJ-NPR-Z0-9]{17}\\b/g;
function direct(url){try{const u=new URL(url);const h=u.hostname.toLowerCase(),p=u.pathname;return !/craigslist|facebook/.test(h)&&((h.endsWith('cars.com')&&/\\/vehicledetail\\/[a-z0-9-]{12,}/i.test(p))||(h.endsWith('autotrader.com')&&/\\/cars-for-sale\\/vehicle\\/\\d+/i.test(p))||(h.endsWith('truecar.com')&&/\\/used-cars-for-sale\\/listing\\/[A-HJ-NPR-Z0-9]{17}/i.test(p))||(h.endsWith('cargurus.com')&&(/listingId=\\d+/.test(u.search)||/\\/Cars\\/(?:detail|link)\\//i.test(p))))}catch{return false}}
async function search(q){const r=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'X-API-KEY':apiKey,'Content-Type':'application/json'},body:JSON.stringify({q,num:10})});if(!r.ok)throw Error('Search HTTP '+r.status);return (await r.json()).organic||[]}
async function scrape(url){const r=await fetch('https://scrape.serper.dev',{method:'POST',headers:{'X-API-KEY':apiKey,'Content-Type':'application/json'},body:JSON.stringify({url,includeMarkdown:true})});if(!r.ok)throw Error('Page HTTP '+r.status);const j=await r.json();return String(j.markdown||j.text||'').slice(0,20000)}
function parse(row,body,model,area){
const title=String(row.title||'');const combined=title+' '+String(row.snippet||'')+' '+body;
if(!model.re.test(combined))return null;
const yr=digits(title.match(/\\b(20(?:1[5-9]|2[0-9]))\\b/)?.[1]||combined.match(/\\b(20(?:1[5-9]|2[0-9]))\\b/)?.[1]);
const vin=(body.match(vinRe)||[]).find(v=>v.length===17)||new URL(row.link).pathname.match(/[A-HJ-NPR-Z0-9]{17}/)?.[0];
const price=digits(combined.match(/(?:sale price|asking price|advertised price|our price|price)\\s*[:\\s$]{0,30}\\$?([0-9]{1,3},[0-9]{3})/i)?.[1]||title.match(/\\$([0-9]{1,3},[0-9]{3})/)?.[1]);
const miles=digits(combined.match(/(?:mileage|odometer|miles)\\s*[:\\s]{0,15}([0-9]{1,3},[0-9]{3})/i)?.[1]||combined.match(/\\b([0-9]{1,3},[0-9]{3})\\s*(?:mi|miles)\\b/i)?.[1]);
if(!vin||!yr||!price||!miles||yr<cfg.minYear||miles>cfg.maxMileage||price<cfg.minPrice||price>cfg.maxPrice)return null;
if(/\\b(sold|sale pending|no longer available)\\b/i.test(title))return null;
const source=new URL(row.link).hostname.replace(/^www\\./,'');
return {id:crypto.createHash('sha1').update(vin).digest('hex').slice(0,12),vin,model:model.name,title,year:yr,price,mileage:miles,source,location:area,url:row.link,snippet:String(row.snippet||'').slice(0,400),foundAt:new Date().toISOString(),lastVerifiedAt:new Date().toISOString(),linkVerified:true,priceVerified:'listing_only',titleVerified:false,accidentVerified:false,cashPriceVerified:false,otdVerified:false,estimatedOTD:Math.round(price*(1+cfg.estimatedTaxRate)+cfg.estimatedGovernmentFees),score:Math.max(0,100-Math.round((miles/100000)*35)-Math.round((price/15000)*15)),status:'needs_dealer_confirmation'};
}
for(const model of models)for(const area of areas)for(const site of sites){
const q='site:'+site+' "'+model.name+'" "'+area+'" 2015..2026 used';
try{const rows=await search(q);for(const row of rows.slice(0,10)){if(!row.link||!direct(row.link)||seen.has(row.link))continue;seen.add(row.link);try{const body=await scrape(row.link);if(!body||/\\b404\\b|page not found|listing unavailable/i.test(body.slice(0,250)))continue;const listing=parse(row,body,model,area);if(listing)results.push(listing)}catch(e){errors.push({url:row.link,error:String(e.message).slice(0,120)})}}}catch(e){errors.push({site,area,model:model.name,error:String(e.message).slice(0,120)})}
}
const uniq=[...new Map(results.map(x=>[x.vin,x])).values()].sort((a,b)=>b.score-a.score);
await fs.writeFile(new URL('data/listings.json',root),JSON.stringify(uniq,null,2)+'\\n');
await fs.writeFile(new URL('data/scan-meta.json',root),JSON.stringify({lastScan:new Date().toISOString(),status:errors.length?'partial':'ok',count:uniq.length,verifiedLinks:uniq.length,unverifiedOTD:uniq.length,errors:errors.slice(0,30)},null,2)+'\\n');
console.log('Verified specific listings:',uniq.length,'errors:',errors.length);
