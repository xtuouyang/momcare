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


/* Actual product links, photos and price evidence come from search results,
   never from model-generated URL strings. */
function shopHttps(raw) {
  try {
    const u=new URL(String(raw||''));
    if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||
       /^(localhost|\d+\.\d+\.\d+\.\d+)$/i.test(u.hostname)) return '';
    if(u.hostname==='e.cn.miaozhen.com') return shopHttps(u.searchParams.get('o'));
    if(/(^|\.)baidu\.com$/i.test(u.hostname)&&u.pathname==='/link') return '';
    return u.href.length<1800?u.href:'';
  }catch{return '';}
}
function actualSellerPage(raw) {
  try {
    const u=new URL(raw),h=u.hostname.toLowerCase(),p=u.pathname;
    if(h==='item.jd.com')return /^\/\d+\.html/i.test(p);
    if(h==='item.taobao.com'||h==='detail.tmall.com')return /item\.htm/i.test(p);
    if(h==='m.mi.com')return /commodity\/detail/i.test(p);
    if(h.endsWith('.suning.com'))return /\/\d+\.html/i.test(p);
    if(h==='detail.1688.com')return /offer\//i.test(p);
    if(h==='www.amazon.cn')return /\/dp\//i.test(p);
    return false;
  }catch{return false;}
}
function yuanPrice(raw) {
  const s=String(raw??'');
  if(!/[¥￥]|(?:^|\s)人民币|\d\s*元/.test(s))return null;
  const m=s.match(/(?:[¥￥]\s*|人民币\s*)([\d,]+(?:\.\d{1,2})?)/)||
          s.match(/([\d,]+(?:\.\d{1,2})?)\s*元/);
  if(!m)return null;
  const n=Number(m[1].replace(/,/g,''));
  return Number.isFinite(n)&&n>0&&n<10000000?n:null;
}
function makeShopProduct(r,inputs,quantity,isShoppingListing) {
  const sourceUrl=shopHttps(r.link||r.product_link||r.url);
  if(!sourceUrl||(!isShoppingListing&&!actualSellerPage(sourceUrl)))return null;
  const name=String(r.title||'').trim().slice(0,170);
  if(!name)return null;
  const imageUrl=shopHttps(r.thumbnail||r.image||r.image_url||r.imageUrl||r.serpapi_thumbnail);
  const priceEvidence=String(r.price||'').trim().slice(0,90);
  const price=yuanPrice(priceEvidence), budget=Number(inputs.budget)||0;
  const total=price===null?null:Math.round(price*quantity*100)/100;
  return {
    name,sourceTitle:name,sourceUrl,imageUrl,
    site:String(r.source||new URL(sourceUrl).hostname).slice(0,90),
    spec:String(r.snippet||inputs.requirements||'以商家商品详情标注为准').slice(0,220),
    price,priceEvidence,total,
    budgetStatus:budget&&total!==null?(total>budget?'高于总预算':'预算范围内'):'页面参考商品',
    reason:'真实搜索结果中的商品候选，请核对材质、适用年龄与产品规格。',
    verify:[inputs.avoid?'避开：'+String(inputs.avoid).slice(0,80):'',
      '核实规格、实际售价、适用年龄、认证、发货与退货政策'].filter(Boolean).join('；')
  };
}
async function searchRealProducts(inputs,env,origin){
  if(!env.SERPAPI_KEY)return json({error:'未配置商品搜索密钥 SERPAPI_KEY。请管理员在 Cloudflare 的 Variables and Secrets 中添加。'},503,origin);
  const item=String(inputs.item||'').trim().slice(0,100);
  if(!item)return json({error:'请先填写希望购买的商品'},400,origin);
  const quantity=Math.min(99,Math.max(1,Math.floor(Number(inputs.quantity)||1)));
  // No family names, medical stages or files leave for the shopping search API.
  const query=[item,String(inputs.brands||'').slice(0,30),
    String(inputs.requirements||'').slice(0,50),'购买'].filter(Boolean).join(' ').slice(0,140);
  const api=new URL('https://serpapi.com/search.json');
  api.searchParams.set('engine','baidu');
  api.searchParams.set('q',query);
  api.searchParams.set('device','mobile');
  api.searchParams.set('api_key',String(env.SERPAPI_KEY));
  let raw;
  try{
    const res=await fetch(api.toString(),{signal:AbortSignal.timeout(18000)});
    if(!res.ok)return json({error:'商品搜索服务暂不可用（HTTP '+res.status+'）'},502,origin);
    raw=await res.json();
    if(raw.error)return json({error:'商品搜索接口返回错误，请检查密钥或搜索额度'},502,origin);
  }catch{return json({error:'商品搜索超时，请稍后重试'},504,origin);}
  const found=[],seen=new Set();
  for(const group of [[raw.shopping_results,true],[raw.organic_results,false]]){
    const rows=Array.isArray(group[0])?group[0]:[];
    for(const r of rows){
      const p=makeShopProduct(r,inputs,quantity,group[1]);
      if(!p||seen.has(p.sourceUrl))continue;
      found.push(p);seen.add(p.sourceUrl);
      if(found.length>=7)break;
    }
    if(found.length>=7)break;
  }
  const budget=Number(inputs.budget)||0;
  if(budget>0)found.sort((a,b)=>{
    const bucket=x=>x.total===null?1:x.total<=budget?0:2;
    return bucket(a)-bucket(b);
  });
  const details=found.length?found.map((p,i)=>
    String(i+1)+'. '+p.name+'；商家 '+p.site+'；网页标价 '+(p.priceEvidence||'暂无') 
  ).join('\n'):'没有找到可核实的具体商品详情链接。';
  let advice='请在商品页核实商家资质、材质、适用年龄、实际标价与售后条件。';
  try{
    const res=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
      body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:320,
        messages:[
          {role:'system',content:'你是母婴用品选购助手。根据真实商品搜索结果给出简短中文购买建议。不能编造链接、价格、库存、认证或未提供的产品规格。未找到商品时说明如何调整搜索关键词。'},
          {role:'user',content:'用户需求：'+JSON.stringify({item:inputs.item,budget:inputs.budget,quantity,requirements:inputs.requirements,avoid:inputs.avoid})+'\n搜索候选：\n'+details}
        ]}),
      signal:AbortSignal.timeout(20000)
    });
    if(res.ok){
      const data=await res.json();
      advice=String(data?.choices?.[0]?.message?.content||'').trim().slice(0,1200)||advice;
    }
  }catch{/* Search-based results remain usable if AI summary is unavailable. */}
  const result={
    version:1,kind:'shopping_web',searchedAt:new Date().toISOString(),query,
    needs:[item,budget?'预算 '+budget+' 元':'','数量 '+quantity,inputs.requirements||''].filter(Boolean).join('；'),
    products:found,conclusion:advice,
    searchUrl:'https://search.jd.com/Search?keyword='+encodeURIComponent(item),
    notice:'商品链接、图片、网页标价来自真实搜索结果，可能包含广告；实际售价、库存、适龄和认证以商家页面为准。没有结果时不编造商品。'
  };
  return json({answer:JSON.stringify(result),source:'deepseek',model:'deepseek-flash',productSource:'serpapi_baidu'},200,origin);
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