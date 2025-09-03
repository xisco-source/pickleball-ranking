// /api/rankings.js
// Minimal endpoint: ?names=Big%20Show,Francisco%20Castillo&mode=doubles
export const config = { runtime: 'edge' }; // fast, no cold starts

const DOUBLES = "https://r.jina.ai/http://www.pickleball.ky/rankings/";
const SINGLES = "https://r.jina.ai/http://www.pickleball.ky/singles-rankings/";

function stripDiacritics(s){return s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"");}
function normName(s){
  if(!s) return "";
  const t=stripDiacritics(s).toLowerCase().replace(/[\.,'’\-]/g," ").replace(/\s+/g," ").trim();
  return t.split(" ").filter(x=>x.length>1).join(" ");
}
function lev(a,b){const an=a.length,bn=b.length;if(!an) return bn;if(!bn) return an;const v0=new Array(bn+1),v1=new Array(bn+1);for(let i=0;i<=bn;i++)v0[i]=i;for(let i=0;i<an;i++){v1[0]=i+1;for(let j=0;j<bn;j++){const c=a[i]===b[j]?0:1;v1[j+1]=Math.min(v1[j]+1,v0[j+1]+1,v0[j]+c);}for(let j=0;j<=bn;j++)v0[j]=v1[j];}return v1[bn];}
function ratio(a,b){const d=lev(a,b),m=Math.max(a.length,b.length)||1;return Math.round((1-d/m)*100);}
function tokenSetRatio(a,b){const A=[...new Set(a.split(" ").filter(Boolean))].sort();const B=[...new Set(b.split(" ").filter(Boolean))].sort();const common=A.filter(t=>B.includes(t)).join(" ");return Math.max(ratio(common,a),ratio(common,b),ratio(A.join(" "),B.join(" ")));}

function parseMarkdown(md){
  const lines=md.split(/\r?\n/); const tables=[];
  for(let i=0;i<lines.length-1;i++){
    const line=lines[i], next=lines[i+1]||"";
    if(/\|.*\|/.test(line) && /\|\s*-{3,}/.test(next)){
      const block=[line,next]; let j=i+2;
      while(j<lines.length && /\|.*\|/.test(lines[j])){block.push(lines[j]); j++;}
      tables.push(block.join("\n")); i=j;
    }
  }
  if(!tables.length) throw new Error("NO_TABLE");
  for(const tbl of tables){
    const rows=tbl.trim().split(/\r?\n/).filter(Boolean);
    if(rows.length<3) continue;
    const header=rows[0].split("|").map(s=>s.trim().toLowerCase());
    let nameIdx=header.findIndex(t=>/name|player/.test(t));
    let rateIdx=header.findIndex(t=>/rating|doubles|singles|cirp/.test(t));
    const dataRows=rows.slice(2).map(r=>r.split("|").map(s=>s.trim()));
    if(nameIdx<0||rateIdx<0){
      const colCount=Math.max(...dataRows.map(r=>r.length)); const numeric=new Array(colCount).fill(0);
      for(const r of dataRows){for(let c=0;c<colCount;c++){const v=(r[c]||"").replace(/[^0-9.]/g,""); if(v && !isNaN(parseFloat(v))) numeric[c]++;}}
      if(rateIdx<0) rateIdx=numeric.indexOf(Math.max(...numeric));
      if(nameIdx<0) nameIdx=numeric.indexOf(Math.min(...numeric));
    }
    const items=[];
    for(const r of dataRows){
      const name=(r[nameIdx]||"").trim();
      const rating=parseFloat((r[rateIdx]||"").replace(/[^0-9.]/g,""));
      if(name && Number.isFinite(rating)) items.push({name, rating});
    }
    if(items.length) {
      const best=new Map();
      for(const it of items){const k=normName(it.name); const prev=best.get(k); if(!prev||it.rating>prev.rating) best.set(k,it);}
      return [...best.values()];
    }
  }
  throw new Error("BAD_SHAPE");
}

async function fetchRankings(mode){
  const url = mode==="singles" ? SINGLES : DOUBLES;
  const res = await fetch(url, { cache: "no-store" });
  if(!res.ok) throw new Error("FETCH_FAIL");
  const text = await res.text();
  return parseMarkdown(text); // r.jina.ai returns markdown-ish content
}

function applyMatching(inputs, rankings){
  const byNorm = new Map(rankings.map(r=>[normName(r.name), r]));
  const matched=[], unmatched=[];
  for(const original of inputs){
    const n = normName(original);
    let f = byNorm.get(n);
    if(!f){
      let best=null, score=0;
      for(const r of rankings){const s=tokenSetRatio(n, normName(r.name)); if(s>score){score=s; best=r;}}
      if(best && score>=80) f=best;
    }
    f ? matched.push({original, player:f.name, rating:f.rating}) 
      : unmatched.push({original, player:original, rating:null});
  }
  matched.sort((a,b)=>b.rating-a.rating);
  let i=1; const rows=[...matched, ...unmatched].map(r=>({...r, sortIndex:r.rating!=null?i++:""}));
  return rows;
}

export default async function handler(req){
  try{
    const { searchParams } = new URL(req.url);
    const names=(searchParams.get("names")||"").split(/[,|\n]/).map(s=>s.trim()).filter(Boolean);
    const mode=(searchParams.get("mode")||"doubles").toLowerCase();
    if(!names.length) return new Response(JSON.stringify({error:"Provide ?names=..."}),{status:400});
    const data = await fetchRankings(mode);
    const rows = applyMatching(names, data);
    return new Response(JSON.stringify({mode, rows}), { headers: { "content-type":"application/json" }});
  }catch(e){
    return new Response(JSON.stringify({error:e.message||"fail"}),{status:500});
  }
}
