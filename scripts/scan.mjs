import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const root=new URL('../',import.meta.url);
const cfg=JSON.parse(await fs.readFile(new URL('config.json',root),'utf8'));
const key=process.env.SERPER_API_KEY;
if(!key) throw new Error('Missing SERPER_API_KEY');

const bad=/(salvage|rebuilt|flood|junk|parts only|certificate of destruction)/i;
const mid=/(accident|damage|lien|title issue|total loss)/i;
const dealer=/(dealer|dealership|financing|monthly payment)/i;
const privateText=/(private seller|by owner|owner sale|selling my|my suv|my vehicle)/i;
const seven=/(7 passenger|8 passenger|third row|3rd row|highlander|pilot|cx-9|mdx|explorer|sorento|traverse|acadia|durango|pathfinder|enclave|qx60|4runner|santa fe xl)/i;
const targetModel=/(Honda\s+Pilot|Toyota\s+Highlander|Ford\s+Explorer|Kia\s+Sorento|Nissan\s+Pathfinder|Chevrolet\s+Traverse|GMC\s+Acadia|Dodge\s+Durango|Acura\s+MDX|Infiniti\s+QX60|Buick\s+Enclave|Mazda\s+CX-9|Toyota\s+4Runner|Hyundai\s+Santa\s+Fe\s+XL)/i;
const allowed=/(craigslist\.org|facebook\.com\/marketplace|privateauto\.com|offerup\.com|ebay\.com|cars\.com|autotrader\.com|cargurus\.com|truecar\.com)/i;

const num=s=>s?Number(String(s).replace(/[^0-9]/g,''))||null:null;
function source(u=''){
 if(/craigslist/i.test(u))return'Craigslist';
 if(/facebook\.com\/marketplace/i.test(u))return'Facebook Marketplace';
 if(/privateauto/i.test(u))return'PrivateAuto';
 if(/offerup/i.test(u))return'OfferUp';
 if(/ebay/i.test(u))return'eBay Motors';
 if(/cars\.com/i.test(u))return'Cars.com';
 if(/autotrader/i.test(u))return'Autotrader';
 if(/cargurus/i.test(u))return'CarGurus';
 if(/truecar/i.test(u))return'TrueCar';
 return'Web';
}
function isSpecificListing(u=''){
 try{
  const url=new URL(u), p=url.pathname;
  if(/craigslist\.org$/i.test(url.hostname)||/\.craigslist\.org$/i.test(url.hostname)) return /\/d\/[^/]+\/\d+\.html$/i.test(p);
  if(/facebook\.com$/i.test(url.hostname)||/\.facebook\.com$/i.test(url.hostname)) return /\/marketplace\/item\/\d+/i.test(p);
  if(/cars\.com$/i.test(url.hostname)||/\.cars\.com$/i.test(url.hostname)) return /\/vehicledetail\//i.test(p);
  if(/autotrader\.com$/i.test(url.hostname)||/\.autotrader\.com$/i.test(url.hostname)) return /\/cars-for-sale\/vehicle\/\d+/i.test(p);
  if(/ebay\.com$/i.test(url.hostname)||/\.ebay\.com$/i.test(url.hostname)) return /\/itm\/\d+/i.test(p);
  if(/offerup\.com$/i.test(url.hostname)||/\.offerup\.com$/i.test(url.hostname)) return /\/item\/detail\//i.test(p);
  if(/privateauto\.com$/i.test(url.hostname)||/\.privateauto\.com$/i.test(url.hostname)) return !/^\/?$/.test(p) && !/\/search|\/browse|\/cars-for-sale/i.test(p);
  if(/cargurus\.com$/i.test(url.hostname)||/\.cargurus\.com$/i.test(url.hostname)) return /listingId=\d+/i.test(u)||/\/Cars\/link\//i.test(p)||/\/Cars\/detail/i.test(p);
  if(/truecar\.com$/i.test(url.hostname)||/\.truecar\.com$/i.test(url.hostname)) return /\/used-cars-for-sale\/listing\//i.test(p);
  return false;
 }catch{return false}
}
function looksLikeSpecificVehicle(v){
 const title=v.title||'', snippet=v.snippet||'', text=title+' '+snippet;
 const generic=/(for sale in|cars for sale|suvs for sale|vehicles for sale|shop used|browse the best|search used|best used|3rd-row seats for sale|all new, used, and certified|used cars for sale near me)/i;
 const vehicleShape=/\b(19|20)\d{2}\b/.test(text) && /(pilot|highlander|explorer|sorento|pathfinder|traverse|acadia|durango|mdx|qx60|enclave|cx-9|4runner|armada|aspen|navigator|gls|yukon|tahoe|suburban|expedition)/i.test(text);
 const priceShape=/\$\s?[0-9]{1,3}(?:,[0-9]{3})+|\$\s?[0-9]{4,5}/.test(text);
 const mileageShape=/\b[0-9]{1,3}(?:,[0-9]{3})+\s*(?:mi|miles)\b/i.test(text);
 if(generic.test(title) && !vehicleShape) return false;
 return vehicleShape && (priceShape || mileageShape);
}
function isDirectListing(u=''){
 try{
  const url=new URL(u), h=url.hostname.toLowerCase(), p=url.pathname;
  if(h.includes('craigslist.org')) return /^\/view\/d\//i.test(p)||/\/d\/[^/]+\/\d+\.html$/i.test(p);
  if(h.includes('facebook.com')) return /^\/marketplace\/item\//i.test(p);
  if(h.includes('cars.com')) return /^\/vehicledetail\//i.test(p);
  if(h.includes('autotrader.com')) return /\/cars-for-sale\/vehicle\//i.test(p);
  if(h.includes('ebay.com')) return /\/itm\//i.test(p);
  if(h.includes('offerup.com')) return /\/item\/detail\//i.test(p);
  if(h.includes('privateauto.com')) return /\/(vehicle|listing)\//i.test(p);
  if(h.includes('cargurus.com')) return /listingId=\d+/i.test(u)||/\/Cars\/(link|detail)\//i.test(p);
  if(h.includes('truecar.com')) return /\/used-cars-for-sale\/listing\//i.test(p);
  return false;
 }catch{return false}
}
function parse(x,area){
 const text=(x.title||'')+' '+(x.snippet||'');
 const preferredPricePatterns=[
  /(?:advertised price|sale price|asking price|list price|our price|price)\s*[:\n ]{0,20}\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})/i,
  /(?:reduced from|priced at|selling for)\s*\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})/i
 ];
 let price=null;
 for(const re of preferredPricePatterns){const m=text.match(re);const v=num(m?.[1]);if(v>=cfg.minPrice&&v<=50000){price=v;break}}
 if(price===null){
  const candidates=[...text.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})/g)]
   .map(m=>({v:num(m[1]),i:m.index||0}))
   .filter(x=>x.v>=cfg.minPrice&&x.v<=50000)
   .filter(x=>!/(save|discount|rebate|down payment|monthly|per month|cash due|shipping|delivery|image|width|height)/i.test(text.slice(Math.max(0,x.i-45),x.i+45)));
  price=candidates.length?candidates[0].v:null;
 }
 const year=num(text.match(/\b(20[0-2][0-9]|19[89][0-9])\b/)?.[1]);
 const mm=text.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\s*(?:mi|miles)/i)||text.match(/odometer\s*[:=-]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/i);
 const mileage=num(mm?.[1]);
 const src=source(x.link||'');
 const privateSeller=(['Craigslist','Facebook Marketplace','PrivateAuto','OfferUp'].includes(src)||privateText.test(text))&&!dealer.test(text);
 const risk=bad.test(text)?'high':mid.test(text)?'medium':'unknown';
 const xl=seven.test(text);
 let score=45; const reasons=[];
 if(price>=cfg.minPrice&&price<=cfg.maxPrice){score+=20;reasons.push('Within $4k-$15k budget')}else{score-=25;reasons.push('Outside price range')};
 if(year&&year>=cfg.minYear){score+=15;reasons.push('Year fits target')}else if(year){score-=20;reasons.push('Older than target')}else reasons.push('Year verify');
 if(mileage&&mileage<=120000){score+=10;reasons.push('Good mileage')}else if(mileage&&mileage<=cfg.maxMileage){score+=5}else if(mileage){score-=10};
 if(privateSeller){score+=10;reasons.push('Private seller likely')}else{reasons.push('Dealer/unknown seller')};
 if(xl){score+=8;reasons.push('7-seat signal')};
 if(risk==='high'){score-=45;reasons.push('Title red flag')}else if(risk==='medium'){score-=12;reasons.push('History warning')};
 score=Math.max(0,Math.min(100,score));
 const inferredTitle=text.match(/\b(20[0-2][0-9]|19[89][0-9])\s+(?:Used\s+)?(?:Honda Pilot|Toyota Highlander|Ford Explorer|Kia Sorento|Nissan Pathfinder|Chevrolet Traverse|GMC Acadia|Dodge Durango|Acura MDX|Infiniti QX60|Buick Enclave|Mazda CX-9)[^\n$]{0,45}/i)?.[0]?.trim()||'';
 return {id:crypto.createHash('sha1').update(x.link).digest('hex').slice(0,12),title:x.title||inferredTitle||'Vehicle listing',url:x.link,snippet:x.snippet||'',source:src,location:area,price,year,mileage,privateSellerLikely:privateSeller,titleRisk:risk,uberXL:xl&&year&&year>=cfg.minYear&&risk!=='high'?'likely':'verify',score,reasons,foundAt:new Date().toISOString()};
}
async function search(q){
 const r=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'X-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify({q,num:10})});
 const body=await r.text();
 if(!r.ok)throw new Error('Serper '+r.status+' '+body.slice(0,120));
 return JSON.parse(body);
}


async function scrapePage(url){
 const r=await fetch('https://scrape.serper.dev',{method:'POST',headers:{'X-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify({url,includeMarkdown:true})});
 const body=await r.text();
 if(!r.ok)throw new Error('Serper scrape '+r.status+' '+body.slice(0,120));
 return JSON.parse(body);
}
function canonicalUrl(raw){
 try{
  const u=new URL(raw);
  if(u.hostname.includes('cars.com')&&/\/vehicledetail\//i.test(u.pathname)) return u.origin+u.pathname;
  if(u.hostname.includes('truecar.com')&&/\/used-cars-for-sale\/listing\//i.test(u.pathname)) return u.origin+u.pathname;
  return u.href;
 }catch{return raw}
}
function extractedDirectRows(data,base){
 const markdown=data.markdown||'', blob=[markdown,data.text||'',JSON.stringify(data)].join('\n');
 const rows=[],seen=new Set();
 const add=(url,title='',snippet='',idx=0)=>{
  try{
   const absolute=new URL(url,base).href, canonical=canonicalUrl(absolute);
   if(!seen.has(canonical)&&allowed.test(canonical)&&isDirectListing(canonical)){
    seen.add(canonical);
    rows.push({link:canonical,title:title||'',snippet:snippet||blob.slice(Math.max(0,idx-220),idx+320)});
   }
  }catch{}
 };
 for(const m of markdown.matchAll(/(?:!\[([^\]]+)\]\([^)]+\)\s*)?\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})\s*[\r\n# *-]*\[([^\]]+)\]\((https?:\/\/(?:www\.)?cars\.com\/vehicledetail\/[^)\s]+)\)/gi)){
  const title=(m[3]||m[1]||'').replace(/^Used\s+/i,'').trim();
  add(m[4],title,title+' price '+String.fromCharCode(36)+m[2],m.index||0);
 }
 for(const m of markdown.matchAll(/##\s+((?:19|20)\d{2}\s+[^\n]{2,90})\n([\s\S]{0,2200}?)\bVIN[:\s]+([A-HJ-NPR-Z0-9]{17})\b/gi)){
  const title=m[1].trim(), block=(title+'\n'+m[2]).trim(), vin=m[3].toUpperCase();
  const pm=block.match(/(?:advertised price|list price|price)\s*[\r\n ]{0,30}\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})/i);
  const mm=block.match(/(?:used\s*[·-]\s*|mileage\s*)?([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:mi|miles)/i);
  if(targetModel.test(title)&&pm){
   const snippet=title+' price '+String.fromCharCode(36)+pm[1]+(mm?' mileage '+mm[1]+' miles':'')+' '+block.slice(0,1200);
   add('https://www.truecar.com/used-cars-for-sale/listing/'+vin+'/',title,snippet,m.index||0);
  }
 }
 for(const m of markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)){
  if(allowed.test(m[2])&&isDirectListing(m[2])) add(m[2],m[1],m[1],m.index||0);
 }
 for(const m of blob.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) add(m[0].replace(/[.,;]+$/,''),'','',m.index||0);
 for(const m of blob.matchAll(/(\/vehicledetail\/[A-Za-z0-9-]+\/?|\/cars-for-sale\/vehicle\/[A-Za-z0-9-]+[^\s)\]"'<>]*|\/marketplace\/item\/\d+[^\s)\]"'<>]*|\/view\/d\/[^\s)\]"'<>]+)/g)) add(m[1],'','',m.index||0);
 for(const m of blob.matchAll(/"listing_id"\s*:\s*"([a-f0-9-]{20,})"/ig)) add('https://www.cars.com/vehicledetail/'+m[1]+'/','','',m.index||0);
 return rows.slice(0,12);
}
async function hydrate(row){
 const t=(row.title||'')+' '+(row.snippet||'');
 if(/\$\s?[0-9]/.test(t)&&/\b(19|20)\d{2}\b/.test(t)&&targetModel.test(t))return row;
 try{
  const d=await scrapePage(row.link);
  const text=(d.markdown||d.text||'').slice(0,7000);
  return {...row,title:d.metadata?.title||row.title||'',snippet:text};
 }catch{return row}
}

const all=[],log=[];
const minivanModel=/(Chrysler\s+Pacifica|Honda\s+Odyssey|Toyota\s+Sienna|Kia\s+Carnival|Kia\s+Sedona|Dodge\s+Grand\s+Caravan|Chrysler\s+Town\s*&?\s*Country)/i;
const wantedModel=new RegExp(targetModel.source+'|'+minivanModel.source,'i');

function addParsed(row,area,force={}){
 const p=parse(row,area);
 Object.assign(p,force);
 const txt=(p.title||'')+' '+(p.snippet||'');
 const modelOk=wantedModel.test(txt);
 const priceOk=p.price!==null&&p.price>=cfg.minPrice&&p.price<=cfg.maxPrice;
 const yearOk=p.year!==null&&p.year>=cfg.minYear;
 const milesOk=p.mileage===null||p.mileage<=cfg.maxMileage;
 if(modelOk&&priceOk&&yearOk&&milesOk&&p.titleRisk!=='high'){all.push(p);return true}
 return false;
}

function trueCarBlocks(md){
 const rows=[];
 const heads=[...md.matchAll(/(?:^|\n)##\s+((?:19|20)\d{2}\s+[^\n]{2,100})/g)];
 for(let i=0;i<heads.length;i++){
  const title=heads[i][1].trim(),a=heads[i].index,b=i+1<heads.length?heads[i+1].index:Math.min(md.length,a+5000);
  const block=md.slice(a,b);
  const vin=block.match(/\bVIN:\s*([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase();
  const price=num(block.match(/(?:ADVERTISED PRICE|Advertised price|LIST PRICE|List price|price)\s*[\r\n *]{0,120}\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})/i)?.[1]);
  const mileage=num(block.match(/Used\s*[·-]\s*([0-9]{1,3}(?:,[0-9]{3})+)\s*mi\b/i)?.[1]||block.match(/([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:mi|miles)\b/i)?.[1]);
  if(vin&&price&&wantedModel.test(title)){
   rows.push({link:'https://www.truecar.com/used-cars-for-sale/listing/'+vin+'/',title,snippet:title+' Advertised price $'+price+(mileage?' '+mileage+' miles':'')+' '+block.slice(0,1800),price,mileage});
  }
 }
 return rows;
}

const trueCarPages=[
 ['New York metro','https://www.truecar.com/used-cars-for-sale/listings/price-below-15000/location-new-york-ny/'],
 ['Long Island','https://www.truecar.com/used-cars-for-sale/listings/price-below-15000/location-central-islip-ny/'],
 ['North Jersey / Hudson','https://www.truecar.com/used-cars-for-sale/listings/price-below-15000/location-nanuet-ny/']
];
for(const [area,url] of trueCarPages){
 try{
  const d=await scrapePage(url),rows=trueCarBlocks(d.markdown||d.text||'');let accepted=0;
  for(const r of rows){if(addParsed(r,area,{price:r.price,mileage:r.mileage,bodyStyle:minivanModel.test(r.title)?'Minivan':'SUV'}))accepted++}
  log.push({collector:'TrueCar',area,url,found:rows.length,accepted});
 }catch(e){log.push({collector:'TrueCar',area,url,error:e.message})}
}

const carsPages=[
 ['New York metro','https://www.cars.com/shopping/new_york-ny/price-under-15000/?page=1'],
 ['Long Island','https://www.cars.com/shopping/suv/long_island-ny/price-under-15000/?page=1'],
 ['North Jersey','https://www.cars.com/shopping/suv/newark-nj/price-under-15000/?page=1'],
 ['Connecticut','https://www.cars.com/shopping/suv/stamford-ct/price-under-15000/?page=1']
];
for(const [area,url] of carsPages){
 try{
  const d=await scrapePage(url),rows=extractedDirectRows(d,url);let accepted=0;
  for(const r of rows){
   if(!wantedModel.test((r.title||'')+' '+(r.snippet||'')))continue;
   if(addParsed(r,area,{bodyStyle:minivanModel.test((r.title||'')+' '+(r.snippet||''))?'Minivan':'SUV'}))accepted++;
  }
  log.push({collector:'Cars.com',area,url,found:rows.length,accepted,samples:rows.slice(0,3).map(r=>r.link)});
 }catch(e){log.push({collector:'Cars.com',area,url,error:e.message})}
}

// Search-index fallback for dealer marketplaces - model-specific queries are much more reliable than grouped model queries.
const dealerModels=['Honda Pilot','Toyota Highlander','Ford Explorer','Kia Sorento','Nissan Pathfinder','Honda Odyssey','Toyota Sienna','Chrysler Pacifica'];
const rotate=dealerModels.slice((new Date().getUTCHours()<12?0:4),(new Date().getUTCHours()<12?4:8));
for(const spec of [
 {name:'Cars.com',domain:'cars.com/vehicledetail'},
 {name:'TrueCar',domain:'truecar.com/used-cars-for-sale/listing'}
]){
 for(const model of rotate){
  const q='site:'+spec.domain+' "'+model+'" "$" (NY OR NJ OR CT)';
  try{
   const j=await search(q);let direct=0,accepted=0;
   for(const r of (j.organic||[]).slice(0,10)){
    if(!r.link||!isDirectListing(r.link))continue;direct++;
    const full=await hydrate({...r,link:canonicalUrl(r.link)});
    const titleOnly=full.title||'';
    if(!new RegExp(model.replace(/[.*+?^$()|[\]\\]/g,'\\$&'),'i').test(titleOnly))continue;
    if(addParsed(full,'NY metro',{bodyStyle:minivanModel.test(titleOnly)?'Minivan':'SUV'}))accepted++;
   }
   log.push({collector:spec.name+' model fallback',model,results:(j.organic||[]).length,direct,accepted});
  }catch(e){log.push({collector:spec.name+' model fallback',model,error:e.message})}
 }
}

// Private-party and Facebook discovery. Facebook is best-effort because Marketplace indexing is inconsistent.
for(const area of cfg.searchAreas){
 for(const spec of [
  {name:'Craigslist',q:'site:craigslist.org/view/d '+area+' (Pilot OR Highlander OR Explorer OR Sorento OR Pathfinder OR Traverse OR Acadia OR Durango OR MDX OR QX60 OR Pacifica OR Odyssey OR Sienna) "$"'},
  {name:'Facebook Marketplace',q:'site:facebook.com/marketplace/item '+area+' (Pilot OR Highlander OR Explorer OR Sorento OR Pathfinder OR Traverse OR Pacifica OR Odyssey OR Sienna) "$"'},
  {name:'Autotrader',q:'site:autotrader.com/cars-for-sale/vehicle '+area+' (Pilot OR Highlander OR Explorer OR Sorento OR Pathfinder OR Traverse) "$"'},
  {name:'CarGurus',q:'site:cargurus.com/Cars '+area+' (Pilot OR Highlander OR Explorer OR Sorento OR Pathfinder OR Traverse) "$"'}
 ]){
  try{
   const j=await search(spec.q);let accepted=0,direct=0;
   for(const r of (j.organic||[])){
    if(!r.link||!isDirectListing(r.link))continue;direct++;
    const titleOnly=r.title||'';
    if(!wantedModel.test(titleOnly))continue;
    if(addParsed({...r,link:canonicalUrl(r.link)},area,{bodyStyle:minivanModel.test(titleOnly)?'Minivan':'SUV'}))accepted++;
   }
   log.push({collector:spec.name,area,results:(j.organic||[]).length,direct,accepted});
  }catch(e){log.push({collector:spec.name,area,error:e.message})}
 }
}

// Keep still-valid previous inventory too, so one source fluctuation does not erase another source.
try{
 const previous=JSON.parse(await fs.readFile(new URL('data/listings.json',root),'utf8'));
 if(Array.isArray(previous)){
  for(const p of previous){
   const age=Date.now()-new Date(p.foundAt||0).getTime();
   if(age<7*24*60*60*1000&&p.url&&p.price>=cfg.minPrice&&p.price<=cfg.maxPrice&&p.year>=cfg.minYear&&(p.mileage==null||p.mileage<=cfg.maxMileage)&&wantedModel.test(p.title||'')) all.push(p);
  }
 }
}catch{}

const uniq=[...new Map(all.map(x=>[canonicalUrl(x.url),{...x,url:canonicalUrl(x.url)}])).values()];
const out=uniq.sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,300);
await fs.writeFile(new URL('data/listings.json',root),JSON.stringify(out,null,2));
await fs.writeFile(new URL('data/scan-meta.json',root),JSON.stringify({lastScan:new Date().toISOString(),status:'ok',count:out.length,rawCount:all.length,uniqueCount:uniq.length,collectors:log},null,2));
console.log('Saved',out.length,'listings');
