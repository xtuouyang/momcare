/* MomCare 竞赛轻量版。Cloudflare Worker 安全代理 DeepSeek。 */
const AI_TITLES = {
  recovery:'妈妈身心关怀', mental:'孕产期心理状态自评', mood:'妈妈情绪关怀',
  nutrition:'妈妈营养规划', feeding:'喂养支持', visit:'就诊准备',
  return:'生活与职业发展', parent_ai:'AI 育儿顾问', baby_food:'宝宝辅食规划',
  storybook:'亲子绘本', summary:'互助社区观点摘要', shopping:'智能商品推荐',
  ai_chat:'家庭关怀问答'
};

function json(data, status=200, origin='') {
  const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(origin) {
    headers['Access-Control-Allow-Origin']=origin;
    headers['Access-Control-Allow-Headers']='Content-Type, X-MomCare-Code';
    headers['Access-Control-Allow-Methods']='POST, OPTIONS';
  }
  return new Response(JSON.stringify(data),{status,headers});
}
function exactEqual(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||!b||a.length!==b.length) return false;
  let diff=0;
  for(let i=0;i<a.length;i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff===0;
}
function sanitizeInputs(obj) {
  if(!obj||typeof obj!=='object'||Array.isArray(obj)) return null;
  const cleaned={};
  for(const [k,v] of Object.entries(obj).slice(0,45)) {
    if(!/^[a-zA-Z_][a-zA-Z_0-9]{0,44}$/.test(k))continue;
    if(typeof v==='string') cleaned[k]=v.slice(0,700);
    else if(typeof v==='number' && Number.isFinite(v))cleaned[k]=v;
    else if(Array.isArray(v) || (v && typeof v==='object'))cleaned[k]=JSON.stringify(v).slice(0,1200);
  }
  return cleaned;
}
const SYSTEM = `你是 MomCare 比赛展示项目的中文家庭照护 AI 助手。回应用户所提交的具体问题。
语言清晰、简洁、可操作，避免营销话术。回复以中文为主，适当分段。
涉及孕产期心理、生理、宝宝饮食和健康，仅提供一般科普信息，不诊断，不提供处方或个体用药方案。
如果用户出现严重危险信号或有伤害自己或孩子的风险，应建议立即寻求专业救助和急诊支持。
不能编造真实商品链接、售价、库存、医疗结论、引用来源或你没有验证过的实时网页信息。
商品推荐根据用户预算和约束给出候选类别与核验条件，不要声称查到了实时商城报价。
对于社区讨论摘要，不将网民经验等同于医学证据。
对于职业规划，给出可以执行的阶段目标、步骤和风险。你不能替用户实际安排工作或承诺岗位。`;


/* DeepSeek native web search; never fabricate sellers, links, images, prices. */
const MAX_SHOP_ITEMS = 5;
function shopHttps(raw) {
  try {
    const u = new URL(String(raw||''));
    if (u.protocol!=='https:' || u.username || u.password || !u.hostname.includes('.') ||
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(u.hostname) ||
      /^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) ||
      /\.(?:local|internal|localhost)$/i.test(u.hostname)) return '';
    return u.href.length<=1600 ? u.href : '';
  } catch { return ''; }
}
function sellerDetailURL(url) {
  try {
    const u=new URL(url);
    const h=u.hostname.toLowerCase(),p=u.pathname;
    if(h==='item.jd.com') return /^\/\d+\.html$/i.test(p);
    if(h==='item.m.jd.com'||h==='item.m.jd.com') return /\/product\/\d+\.html/i.test(p);
    if(h==='item.taobao.com'||h==='detail.tmall.com') return /\/item\.htm/i.test(p)&&u.searchParams.has('id');
    if(h==='mobile.yangkeduo.com') return /goods\.html/i.test(p)&&u.searchParams.has('goods_id');
    if(h==='detail.1688.com') return /\/offer\/\d+\.html/i.test(p);
    if(h==='product.suning.com') return /\/\d+\/\d+\.html/i.test(p);
    if(h==='product.dangdang.com') return /\/\d+\.html/i.test(p);
    if(h==='www.amazon.cn'||h==='www.amazon.com') return /\/(?:dp|gp\/product)\//i.test(p);
    if(h==='m.mi.com') return /\/commodity\/detail\//i.test(p);
    return false;
  } catch { return false; }
}
function yuanPrice(snippet) {
  const s=String(snippet||'');
  const m=s.match(/(?:[¥￥]\s*|人民币\s*)([\d,]+(?:\.\d{1,2})?)/) ||
    s.match(/([\d,]+(?:\.\d{1,2})?)\s*元/);
  if(!m)return null;
  const n=Number(m[1].replace(/,/g,''));
  return Number.isFinite(n)&&n>0&&n<1000000?n:null;
}
function sourceRows(response) {
  const calls=response?.choices?.[0]?.message?.server_tool_calls||[];
  const out=[],seen=new Set();
  for(const call of calls) {
    const sources=Array.isArray(call.sources)?call.sources:
      Array.isArray(call?.result?.sources)?call.result.sources:[];
    for(const source of sources) {
      const url=shopHttps(source.url);
      if(!url||seen.has(url))continue;
      seen.add(url);
      out.push({
        url, title:String(source.title||'').replace(/<[^>]*>/g,'').slice(0,160),
        snippet:String(source.snippet||'').replace(/<[^>]*>/g,'').slice(0,700),
        site:String(source.site_name||new URL(url).hostname).slice(0,80),
        imageUrl:shopHttps(source.image_url)
      });
      if(out.length>=40)return out;
    }
  }
  return out;
}
function productFromSource(source,quantity,budget,inputs) {
  if(!sellerDetailURL(source.url))return null;
  const price=yuanPrice(source.snippet);
  const total=price===null?null:Math.round(price*quantity*100)/100;
  return {
    name:source.title||String(inputs.item||'商品').slice(0,100),
    sourceUrl:source.url,sourceTitle:source.title,site:source.site,
    imageUrl:source.imageUrl,price,
    priceEvidence:price===null?'':source.snippet.slice(0,220),
    total,budgetStatus:budget&&total!==null?(total<=budget?'预算范围内':'超出总预算'):'待核实',
    spec:String(inputs.requirements||source.snippet||'以商品详情为准').slice(0,190),
    reason:'这是真实联网结果中的商品详情链接，需进一步核对规格与需求是否一致。',
    verify:'核实实际售价、运费、规格、适用年龄、材料和售后条件。'
  };
}
async function productPageImage(url) {
  if(!sellerDetailURL(url))return '';
  try {
    const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(3500),headers:{Accept:'text/html'}});
    if(res.status!==200||!/text\/html/i.test(res.headers.get('Content-Type')||''))return '';
    const reader=res.body?.getReader();
    if(!reader)return '';
    const decoder=new TextDecoder();let markup='',count=0;
    try {
      while(count<100000){
        const {done,value}=await reader.read();
        if(done)break;
        const bytes=value.subarray(0,Math.max(0,100000-count));
        markup+=decoder.decode(bytes,{stream:true});count+=bytes.length;
        if(markup.includes('og:image'))break;
      }
    } finally {await reader.cancel().catch(()=>{});}
    const tags=markup.match(/<meta\b[^>]*>/gi)||[];
    for(const tag of tags.slice(0,150)) {
      if(!/(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["']/i.test(tag))continue;
      const match=tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
      if(match) {
        const image=shopHttps(match[1].replace(/&amp;/g,'&'));
        if(image)return image;
      }
    }
  } catch {}
  return '';
}
async function searchRealProducts(inputs,env,origin) {
  const item=String(inputs.item||'').trim().slice(0,100);
  if(!item)return json({error:'请填写希望购买的商品'},400,origin);
  const quantity=Math.min(99,Math.max(1,Math.floor(Number(inputs.quantity)||1)));
  const budget=Math.max(0,Number(inputs.budget)||0);
  const query=[item,String(inputs.brands||'').slice(0,35),
    String(inputs.requirements||'').slice(0,90),'京东 天猫 淘宝 购买'].filter(Boolean).join(' ').slice(0,180);
  const task='请先真正联网检索中国电商平台正在展示的“'+query+'”相关商品。'+
    '重点查找实际商品详情页，不要生成或猜测任何商品地址。最多挑选5款商品比较。'+
    '给出中文简短选购建议和需要核对的规格，不编造价格、库存、认证或图片；'+
    '如果没有搜到可靠商品，就明确说明找不到。';
  let response;
  try {
    const res=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
      body:JSON.stringify({
        model:'deepseek-flash',thinking:{type:'disabled'},
        tools:[{type:'deepseek_web_search'}],
        max_tokens:950,
        messages:[
          {role:'system',content:'你是 MomCare 比赛网站的中文母婴商品选购助手。回答前用联网搜索获得实际来源。只做消费建议，不诊断或承诺产品安全。不要编造商品链接、价格或来源。'},
          {role:'user',content:task}
        ]
      }),signal:AbortSignal.timeout(45000)
    });
    if(!res.ok) {
      if(res.status===401)return json({error:'DeepSeek 密钥无效，请管理员检查'},502,origin);
      if(res.status===402)return json({error:'DeepSeek 账户余额不足'},502,origin);
      if(res.status===429)return json({error:'AI 请求过于频繁，请稍后重试'},429,origin);
      return json({error:'DeepSeek 联网搜索暂不可用（'+res.status+'）'},502,origin);
    }
    response=await res.json();
    if(response?.error) return json({error:'DeepSeek 未能完成联网搜索，请稍后重试'},502,origin);
  } catch {return json({error:'DeepSeek 联网搜索超时或网络异常'},504,origin);}
  const sources=sourceRows(response);
  let products=sources.map(x=>productFromSource(x,quantity,budget,inputs)).filter(Boolean);
  // Only genuine web-search source URLs qualify. Model-written URLs are ignored.
  if(budget>0)products.sort((a,b)=>{
    const priority=p=>p.total===null?1:p.total<=budget?0:2;
    return priority(a)-priority(b);
  });
  products=products.slice(0,MAX_SHOP_ITEMS);
  // A photo is shown only when returned by search or extracted from that real seller page.
  await Promise.all(products.map(async p=>{
    if(!p.imageUrl)p.imageUrl=await productPageImage(p.sourceUrl);
  }));
  const rawAdvice=String(response?.choices?.[0]?.message?.content||'').trim();
  const advice=rawAdvice.replace(/https?:\/\/\S+/g,'（具体链接请见商品卡片）')
    .slice(0,1100) ||
    '请按预算与适用年龄核对商品详情。搜索结果不代表实时价格或安全认证。';
  const out={
    version:1,kind:'shopping_web',maxResults:MAX_SHOP_ITEMS,
    searchedAt:new Date().toISOString(),query,
    needs:[item,budget?'总预算 '+budget+' 元':'','数量 '+quantity,
      inputs.requirements||''].filter(Boolean).join('；'),
    products,conclusion:advice,
    searchUrl:'https://search.jd.com/Search?keyword='+encodeURIComponent(item),
    notice:'仅展示至多5款实际联网搜索中找到的商品详情链接。价格来自搜索摘要，可能已变化；图片可能因商家限制而缺失。请核对商家及产品真实信息。'
  };
  return json({answer:JSON.stringify(out),source:'deepseek',model:'deepseek-flash',productSource:'deepseek_web_search'},200,origin);
}

export default {
 async fetch(req, env) {
   const url = new URL(req.url);
   const reqOrigin = req.headers.get('Origin') || '';
   const allowed = String(env.ALLOWED_ORIGIN || '').trim().replace(/\/$/, '');
   const origin = allowed && reqOrigin === allowed ? reqOrigin : '';
   if(url.pathname==='/health' && req.method==='GET') return json({ok:true,service:'MomCare AI gateway'},200,origin);
   if(url.pathname!=='/api/chat') return json({error:'路径不存在'},404,origin);
   if(reqOrigin && !origin) return json({error:'请求来源未授权，请检查 ALLOWED_ORIGIN'},403);
   if(req.method==='OPTIONS') return new Response(null,{status:204,headers:{
     'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type, X-MomCare-Code',
     'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Max-Age':'3600','Vary':'Origin'
   }});
   if(req.method!=='POST') return json({error:'仅支持 POST'},405,origin);
   if(!env.DEEPSEEK_API_KEY || !env.ACCESS_CODE || !allowed) return json({error:'服务尚未完成密钥或来源配置'},503,origin);
   const submitted = req.headers.get('X-MomCare-Code') || '';
   if(!exactEqual(submitted,env.ACCESS_CODE)) return json({error:'体验码错误，请点击页面右下角更换体验码'},401,origin);
   if(Number(req.headers.get('Content-Length') || 0) > 12000) return json({error:'输入内容太长'},413,origin);
   // Optional Cloudflare Rate Limiting binding, recommended in wrangler.jsonc.
   if(env.AI_LIMITER) {
     const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
     const {success} = await env.AI_LIMITER.limit({key:ip});
     if(!success) return json({error:'操作太频繁，请稍后再试'},429,origin);
   }
   let body;
   try {const raw = await req.text(); if(raw.length>12000) return json({error:'输入内容太长'},413,origin); body=JSON.parse(raw);} 
   catch {return json({error:'请求 JSON 无效'},400,origin);}
   const kind=String(body?.kind||'');
   if(!Object.prototype.hasOwnProperty.call(AI_TITLES,kind)) return json({error:'不支持的功能类型'},400,origin);
   const inputs = sanitizeInputs(body?.inputs);
   if(!inputs || Object.keys(inputs).length===0) return json({error:'请先输入内容'},400,origin);
   if(kind==='shopping') return searchRealProducts(inputs,env,origin);
   let detail=JSON.stringify(inputs);
   if(detail.length>6500) detail=detail.slice(0,6500);
   const prompt = `当前功能：${AI_TITLES[kind]}。\n用户在表单中提供的内容（JSON）：\n${detail}\n请以该功能目标回应。`;
   try {
     const res=await fetch('https://api.deepseek.com/chat/completions',{
       method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
       body: JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:800,
         messages:[{role:'system',content:SYSTEM},{role:'user',content:prompt}]}),
       signal:AbortSignal.timeout(45000)
     });
     if(!res.ok) {
       // Do not expose credentials, endpoint body, stack traces, or account data.
       if(res.status===401) return json({error:'DeepSeek API Key 无效，请网站管理者更新密钥'},502,origin);
       if(res.status===402) return json({error:'DeepSeek 账户额度不足，请网站管理者充值'},502,origin);
       if(res.status===429) return json({error:'DeepSeek 服务请求过于频繁，请稍后重试'},503,origin);
       return json({error:'DeepSeek 接口暂时不可用（'+res.status+'）'},502,origin);
     }
     const data=await res.json();
     const answer=String(data?.choices?.[0]?.message?.content||'').trim();
     if(!answer) return json({error:'DeepSeek 返回空内容，请重试'},502,origin);
     return json({answer,source:'deepseek',model:'deepseek-flash'},200,origin);
   } catch (e) {
     return json({error:'AI 请求超时或网络暂不可用，请稍后重试'},504,origin);
   }
 }
};