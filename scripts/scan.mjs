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
const seven=/(7 passenger|8 passenger|third row|3rd row|highlander|pilot|cx-9|mdx|explorer|sorento|traverse|acadia|durango|pathfinder|enclave|qx60|4runner)/i;
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
function parse(x,area){
 const text=(x.title||'')+' '+(x.snippet||'');
 const prices=[...text.matchAll(/\$\s?([0-9]{4,5}|[0-9]{1,3}(?:,[0-9]{3})+)/g)].map(m=>num(m[1])).filter(v=>v>=2000&&v<=50000);
 const price=prices.length?Math.min(...prices):null;
 const year=num(text.match(/\b(20[0-2][0-9]|19[89][0-9])\b/)?.[1]);
 const mm=text.match(/([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:mi|miles)/i);
 const mileage=num(mm?.[1]);
 const src=source(x.link||'');
 const privateSeller=(['Craigslist','Facebook Marketplace','PrivateAuto','OfferUp'].includes(src)||privateText.test(text))&&!dealer.test(text);
 const risk=bad.test(text)?'high':mid.test(text)?'medium':'unknown';
 const xl=seven.test(text);
 let score=45; const reasons=[];
 if(price&&price<=cfg.maxPrice){score+=20;reasons.push('Within budget')}else if(price){score-=20;reasons.push('Over budget')}else reasons.push('Price verify');
 if(year&&year>=cfg.minYear){score+=15;reasons.push('Year fits target')}else if(year){score-=20;reasons.push('Older than target')}else reasons.push('Year verify');
 if(mileage&&mileage<=120000){score+=10;reasons.push('Good mileage')}else if(mileage&&mileage<=cfg.maxMileage){score+=5}else if(mileage){score-=10};
 if(privateSeller){score+=10;reasons.push('Private seller likely')}else{reasons.push('Dealer/unknown seller')};
 if(xl){score+=8;reasons.push('7-seat signal')};
 if(risk==='high'){score-=45;reasons.push('Title red flag')}else if(risk==='medium'){score-=12;reasons.push('History warning')};
 score=Math.max(0,Math.min(100,score));
 return {id:crypto.createHash('sha1').update(x.link).digest('hex').slice(0,12),title:x.title||'',url:x.link,snippet:x.snippet||'',source:src,location:area,price,year,mileage,privateSellerLikely:privateSeller,titleRisk:risk,uberXL:xl&&year&&year>=cfg.minYear&&risk!=='high'?'likely':'verify',score,reasons,foundAt:new Date().toISOString()};
}
async function search(q){
 const r=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'X-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify({q,num:10})});
 const body=await r.text();
 if(!r.ok)throw new Error('Serper '+r.status+' '+body.slice(0,120));
 return JSON.parse(body);
}

const all=[],log=[];
for(const area of cfg.searchAreas){
 const queries=[
  'Honda Pilot Toyota Highlander Ford Explorer Kia Sorento '+area+' used vehicle listing',
  'Pathfinder Traverse Acadia Durango MDX QX60 Enclave '+area+' used vehicle listing',
  'site:craigslist.org '+area+' Honda Pilot OR Highlander OR Explorer OR Sorento',
  'site:cars.com/vehicledetail '+area+' Honda Pilot OR Highlander OR Pathfinder OR Traverse'
 ];
 for(const q of queries){
  try{
   const j=await search(q), rows=(j.organic||[]).filter(v=>v.link&&allowed.test(v.link)&&isSpecificListing(v.link));
   log.push({area,query:q,results:(j.organic||[]).length,kept:rows.length});
   for(const row of rows)all.push(parse(row,area));
  }catch(e){log.push({area,query:q,error:e.message})}
 }
}
const uniq=[...new Map(all.map(x=>[x.url,x])).values()];
const out=uniq.filter(x=>(!x.price||x.price<=cfg.maxPrice*1.08)&&(!x.year||x.year>=cfg.minYear-1)).sort((a,b)=>b.score-a.score).slice(0,250);
await fs.writeFile(new URL('data/listings.json',root),JSON.stringify(out,null,2));
await fs.writeFile(new URL('data/scan-meta.json',root),JSON.stringify({lastScan:new Date().toISOString(),status:'ok',count:out.length,rawCount:all.length,uniqueCount:uniq.length,queriesRun:log.length,queryLog:log},null,2));
console.log('Saved',out.length,'listings');
