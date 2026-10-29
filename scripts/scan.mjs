import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const root=new URL('../',import.meta.url);
const cfg=JSON.parse(await fs.readFile(new URL('config.json',root),'utf8'));
const apiKey=process.env.SERPER_API_KEY;
if(!apiKey)throw Error('Missing SERPER_API_KEY');
const sites=['cars.com','autotrader.com','truecar.com','cargurus.com','carmax.com'];
const models=[{name:'Toyota Sienna XLE',re:/\bToyota\s+Sienna\b[\s\S]{0,40}\bXLE\b/i},{name:'Toyota RAV4 XLE',re:/\bToyota\s+RAV4\b[\s\S]{0,40}\bXLE\b/i}];
const areas=['New York','Long Island','New Jersey','Connecticut'];
const results=[],errors=[],seen=new Set(),diagnostics={queries:0,searchHits:0,directLinks:0,pagesRead:0,rejected:{},examples:[]};
const reject=(reason,url)=>{diagnostics.rejected[reason]=(diagnostics.rejected[reason]||0)+1;if(diagnostics.examples.length<12)diagnostics.examples.push({reason,url})};
const digits=s=>Number(String(s||'').replace(/[^0-9]/g,''))||null;
const vinRe=/\b[A-HJ-NPR-Z0-9]{17}\b/g;
function direct(url){try{const u=new URL(url);const h=u.hostname.toLowerCase(),p=u.pathname;return !/craigslist|facebook/.test(h)&&((h.endsWith('cars.com')&&/\/vehicledetail\/[a-z0-9-]{12,}/i.test(p))||(h.endsWith('autotrader.com')&&/\/cars-for-sale\/vehicle\/\d+/i.test(p))||(h.endsWith('truecar.com')&&/\/used-cars-for-sale\/listing\/[A-HJ-NPR-Z0-9]{17}/i.test(p))||(h.endsWith('cargurus.com')&&(/listingId=\d+/.test(u.search)||/\/Cars\/(?:detail|link)\//i.test(p)))||(h.endsWith('carmax.com')&&/\/car\/\d+/i.test(p)))}catch{return false}}
async function search(q){const r=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'X-API-KEY':apiKey,'Content-Type':'application/json'},body:JSON.stringify({q,num:10})});if(!r.ok)throw Error('Search HTTP '+r.status);return (await r.json()).organic||[]}
async function scrape(url){const r=await fetch('https://scrape.serper.dev',{method:'POST',headers:{'X-API-KEY':apiKey,'Content-Type':'application/json'},body:JSON.stringify({url,includeMarkdown:true})});if(!r.ok)throw Error('Page HTTP '+r.status);const j=await r.json();return String(j.markdown||j.text||'').slice(0,20000)}
function parse(row,body,model,area){
const title=String(row.title||'');const combined=title+' '+String(row.snippet||'')+' '+body.slice(0,9000);
if(!model.re.test(combined)){reject('model',row.link);return null}
const yr=digits(title.match(/\b(20(?:1[5-9]|2[0-9]))\b/)?.[1]||combined.match(/\b(20(?:1[5-9]|2[0-9]))\b/)?.[1]);
const vin=(body.match(/(?:VIN|vehicle identification number)\s*[:#-]?\s*([A-HJ-NPR-Z0-9]{17})/i)?.[1]||new URL(row.link).pathname.match(/[A-HJ-NPR-Z0-9]{17}/)?.[0]||null);
const price=digits(title.match(/\$\s*([0-9]{1,3},[0-9]{3})/)?.[1]||combined.match(/(?:sale price|asking price|advertised price|our price|price)\s*[:\s$]{0,30}\$?([0-9]{1,3},[0-9]{3})/i)?.[1]||combined.match(/\$\s*([0-9]{1,3},[0-9]{3})/)?.[1]);
const miles=digits(combined.match(/(?:mileage|odometer|miles)\s*[:\s]{0,15}([0-9]{1,3},[0-9]{3})/i)?.[1]||combined.match(/\b([0-9]{1,3},[0-9]{3})\s*(?:mi|miles)\b/i)?.[1]);
if(!vin||!yr||!price||!miles){reject('missing_'+[!vin&&'vin',!yr&&'year',!price&&'price',!miles&&'mileage'].filter(Boolean).join('_'),row.link);return null}if(yr<cfg.minYear||miles>cfg.maxMileage||price<cfg.minPrice||price>cfg.maxPrice){reject('outside_limits',row.link);return null}
if(/\b(sold|sale pending|no longer available)\b/i.test(title))return null;
const source=new URL(row.link).hostname.replace(/^www\./,'');
return {id:crypto.createHash('sha1').update(vin).digest('hex').slice(0,12),vin,model:model.name,title,year:yr,price,mileage:miles,source,location:area,url:row.link,snippet:String(row.snippet||'').slice(0,400),foundAt:new Date().toISOString(),lastVerifiedAt:new Date().toISOString(),linkVerified:true,priceVerified:'listing_only',titleVerified:false,accidentVerified:false,cashPriceVerified:false,otdVerified:false,estimatedOTD:Math.round(price*(1+cfg.estimatedTaxRate)+cfg.estimatedGovernmentFees),score:Math.max(0,100-Math.round((miles/100000)*35)-Math.round((price/15000)*15)),status:'needs_dealer_confirmation'};
}
for(const model of models)for(const area of areas)for(const site of sites){
 const q='site:'+site+' Toyota '+(model.name.includes('Sienna')?'Sienna':'RAV4')+' XLE '+area+' used 2015 2016 2017 2018 2019 under $15000';
 try{
  diagnostics.queries++;
  const rows=await search(q);diagnostics.searchHits+=rows.length;
  for(const row of rows.slice(0,10)){
   if(!row.link||!direct(row.link)){reject('not_direct',row.link||'');continue}
   if(seen.has(row.link))continue;
   seen.add(row.link);diagnostics.directLinks++;
   if(diagnostics.pagesRead>=60)continue;
   try{
    const body=await scrape(row.link);diagnostics.pagesRead++;
    if(!body||/\\b404\\b|page not found|listing unavailable/i.test(body.slice(0,250))){reject('unavailable',row.link);continue}
    const listing=parse(row,body,model,area);
    if(listing)results.push(listing);
   }catch(e){errors.push({url:row.link,error:String(e.message).slice(0,120)})}
  }
 }catch(e){errors.push({site,area,model:model.name,error:String(e.message).slice(0,120)})}
}
const uniq=[...new Map(results.map(x=>[x.vin,x])).values()].sort((a,b)=>b.score-a.score);
await fs.writeFile(new URL('data/listings.json',root),JSON.stringify(uniq,null,2)+'\n');
await fs.writeFile(new URL('data/scan-meta.json',root),JSON.stringify({lastScan:new Date().toISOString(),status:errors.length?'partial':uniq.length?'ok':'no_matches',count:uniq.length,verifiedLinks:uniq.length,unverifiedOTD:uniq.length,errors:errors.slice(0,30),diagnostics},null,2)+'\n');
console.log('Toyota listing scan diagnostics:',JSON.stringify({count:uniq.length,errors:errors.length,...diagnostics}));
