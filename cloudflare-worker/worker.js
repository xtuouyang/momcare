/* MomCare 竞赛轻量版。Cloudflare Worker 安全代理 DeepSeek。 */
const AI_TITLES = {
  recovery:'妈妈身心关怀', mental:'孕产期心理状态自评', mood:'妈妈情绪关怀',
  nutrition:'妈妈营养规划', feeding:'喂养支持', visit:'就诊准备',
  return:'生活与职业发展', parent_ai:'AI 育儿顾问', baby_food:'宝宝辅食规划',
  storybook:'AI 小故事', summary:'互助社区观点摘要', shopping:'智能商品推荐',
  ai_chat:'家庭关怀问答'
};

function json(data, status=200, origin='') {
  const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(origin) {
    headers['Access-Control-Allow-Origin']=origin;
    headers['Access-Control-Allow-Headers']='Content-Type';
    headers['Access-Control-Allow-Methods']='POST, OPTIONS';
  }
  return new Response(JSON.stringify(data),{status,headers});
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
  const message=response?.choices?.[0]?.message||{};
  const steps=Array.isArray(message.server_tool_calls)?message.server_tool_calls:[];
  const calls=steps.flatMap(step=>Array.isArray(step.calls)?step.calls:[step]);
  const rows=[],seen=new Set();
  function append(src) {
    const url=shopHttps(src?.url);
    if(!url||seen.has(url))return;
    seen.add(url);
    rows.push({
      url,title:String(src.title||'').replace(/<[^>]*>/g,'').slice(0,180),
      snippet:String(src.snippet||'').replace(/<[^>]*>/g,'').slice(0,1000),
      site:String(src.site_name||new URL(url).hostname).slice(0,90),
      imageUrl:shopHttps(src.image_url),
      score:Number(src.rerank_score)||0
    });
  }
  for(const call of calls) {
    if(call?.status==='failed')continue;
    const list=Array.isArray(call.sources)?call.sources:
      Array.isArray(call.action?.sources)?call.action.sources:[];
    for(const src of list)append(src);
  }
  // Citations are references, not model-written URLs.
  for(const a of Array.isArray(message.annotations)?message.annotations:[]) {
    if(a?.type==='url_citation'&&a.url_citation?.url)
      append({url:a.url_citation.url,title:a.url_citation.title||'',snippet:''});
  }
  return rows.slice(0,60);
}
async function deepSeekSearchFallback(query,env){
  // DeepSeek's standalone Search API uses the SAME key.
  // A successful search costs $0.00075, so this fallback is used only if needed.
  try{
    const response=await fetch('https://api.deepseek.com/v1/tools/search',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
      body:JSON.stringify({query:query.slice(0,128),count:18,need_content:false}),
      signal:AbortSignal.timeout(15000)
    });
    if(!response.ok)return [];
    const data=await response.json();
    return (Array.isArray(data?.results)?data.results:[]).map(r=>({
      url:shopHttps(r.url),title:String(r.title||'').slice(0,180),
      snippet:String(r.snippet||r.summary||'').slice(0,1000),
      site:String(r.site_name||'').slice(0,90),
      imageUrl:'',score:Number(r.rerank_score)||0
    })).filter(r=>r.url);
  }catch{return [];}
}
function productFromSource(source,quantity,budget,inputs) {
  if(!sellerDetailURL(source.url))return null;
  const price=yuanPrice(source.snippet);
  const total=price===null?null:Math.round(price*quantity*100)/100;
  return {
    name:source.title||String(inputs.item||'商品').slice(0,100),
    sourceUrl:source.url,sourceTitle:source.title,site:source.site||new URL(source.url).hostname,
    linkType:'商品详情页', imageUrl:source.imageUrl||'',price,
    priceEvidence:price===null?'':source.snippet.slice(0,220),
    total,budgetStatus:budget&&total!==null?(total<=budget?'预算范围内':'超出总预算'):'待核价',
    spec:String(source.snippet||'商品搜索摘要未提供详细规格，请查看商品页面').slice(0,210),
    reason:'来自实际联网搜索的商品详情页，建议进一步对照购买需求。',
    verify:'核实材质、规格、适用年龄、运费、库存、真实售价、商家与售后政策。',
    score:source.score||0
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
function relevantProduct(p,inputs){
  const text=(p.name+' '+p.spec).toLowerCase(), wanted=String(inputs.item||'').trim().toLowerCase();
  // Disqualify an explicit excluded brand or material when text confirms a conflict.
  const avoid=String(inputs.avoid||'').split(/[、，,；;\/\n]/).map(x=>x.trim().toLowerCase()).filter(x=>x.length>=2);
  if(avoid.some(x=>text.includes(x)))return false;
  const tokens=wanted.split(/\s+/).filter(x=>x.length>1);
  if(tokens.length>1&&!tokens.some(x=>text.includes(x)))return false;
  return true;
}
async function personalizeProducts(products,inputs,env) {
  const fallback='请核对商品适用对象、实际售价、材质、规格与商家售后，婴幼儿用品尤其注意年龄限制。';
  if(!products.length)return {conclusion:'没有找到能够核验的具体商品详情链接，请调整搜索关键词或使用下方商城搜索入口。'};
  const source=products.map((p,i)=>({id:i+1,name:p.name,site:p.site,snippet:p.spec,
    pagePrice:p.priceEvidence||'未提供',budgetStatus:p.budgetStatus}));
  const user={
    item:inputs.item,quantity:inputs.quantity,budget:inputs.budget,target:inputs.target,
    stage:inputs.stage,age:inputs.age,brands:inputs.brands,
    requirements:inputs.requirements,avoid:inputs.avoid
  };
  try{
    const res=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
      body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:850,
        response_format:{type:'json_object'},
        messages:[
          {role:'system',content:'你是专业的中文母婴用品选购助手。只依据给定的商品搜索资料，输出JSON对象：{"reasons":[{"id":1,"reason":"...","verify":"..."}],"conclusion":"..."}。每款用简短、具体的预算、适龄、材质或功能匹配分析。不能编造产品认证、价格、材质、链接、图片或缺少证据的安全承诺。用户限定条件需要认真遵守。'},
          {role:'user',content:'用户选购需求：'+JSON.stringify(user).slice(0,2200)+'\n候选商品来源：'+JSON.stringify(source).slice(0,4000)}
        ]}),signal:AbortSignal.timeout(18000)
    });
    if(!res.ok)return {conclusion:fallback};
    const data=await res.json(), raw=String(data?.choices?.[0]?.message?.content||'');
    const o=JSON.parse(raw);
    for(const line of Array.isArray(o.reasons)?o.reasons:[]) {
      const ix=Number(line.id)-1;
      if(!Number.isInteger(ix)||ix<0||ix>=products.length)continue;
      if(typeof line.reason==='string')products[ix].reason=line.reason.slice(0,240);
      if(typeof line.verify==='string')products[ix].verify=line.verify.slice(0,220);
    }
    return {conclusion:String(o.conclusion||fallback).slice(0,1100)};
  }catch{return {conclusion:fallback};}
}
async function searchRealProducts(inputs,env,origin) {
  const item=String(inputs.item||'').trim().slice(0,100);
  if(!item)return json({error:'请填写希望购买的商品'},400,origin);
  const quantity=Math.min(99,Math.max(1,Math.floor(Number(inputs.quantity)||1)));
  const budget=Math.max(0,Number(inputs.budget)||0);
  const query=[item,String(inputs.brands||'').slice(0,30),
    String(inputs.requirements||'').slice(0,55),'京东 淘宝 天猫 商品 购买'].filter(Boolean).join(' ').slice(0,128);
  const task='请现在实际联网搜索下面的购物需求，优先查找京东、淘宝、天猫等中国电商的单件商品详情页。'+
    '要严格满足用途、使用人群、宝宝月龄、禁用材料、品牌、总预算和数量，不要编造链接或价格。'+
    '\n需求：'+JSON.stringify({item,quantity,budget,brands:inputs.brands,target:inputs.target,
      stage:inputs.stage,age:inputs.age,requirements:inputs.requirements,avoid:inputs.avoid}).slice(0,1800)+
    '\n请给出至多五个有根据的候选，以及简洁的选购建议；没有真实结果就说明。';
  if(!env.DEEPSEEK_API_KEY)return json({error:'未配置 DeepSeek API Key'},503,origin);
  let response,searchError='';
  try {
    const res=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
      body:JSON.stringify({
        model:'deepseek-flash',thinking:{type:'disabled'},
        tools:[{type:'deepseek_web_search'}],max_tokens:1050,
        messages:[
          {role:'system',content:'你是 MomCare 比赛网站的商品选购助手。必须联网查询有来源的商品资料。不得捏造价格、商品图、商城地址、产品安全结论。用户填写的要求决定筛选顺序。'},
          {role:'user',content:task}
        ]
      }),signal:AbortSignal.timeout(39000)
    });
    if(!res.ok) {
      if(res.status===401)return json({error:'DeepSeek 密钥无效，请管理员检查'},502,origin);
      if(res.status===402)return json({error:'DeepSeek 账户余额不足'},502,origin);
      if(res.status===429)return json({error:'AI 请求过于频繁，请稍后重试'},429,origin);
      searchError='联网模型请求未成功';
    }else response=await res.json();
  }catch {searchError='联网模型超时';}
  const rows=sourceRows(response);
  const direct=rows.map(r=>productFromSource(r,quantity,budget,inputs)).filter(Boolean);
  // Search API is a low-cost fallback and uses exactly the existing DeepSeek key.
  // Avoid charging this extra request when native model search already found five items.
  if(direct.length<MAX_SHOP_ITEMS){
    const extra=await deepSeekSearchFallback(query,env);
    const seen=new Set(rows.map(r=>r.url));
    for(const r of extra)if(!seen.has(r.url)){rows.push(r);seen.add(r.url);}
  }
  const seen=new Set();
  let products=rows.map(r=>productFromSource(r,quantity,budget,inputs))
    .filter(p=>{
      if(!p||seen.has(p.sourceUrl)||!relevantProduct(p,inputs))return false;
      seen.add(p.sourceUrl);return true;
    });
  let overBudget=0;
  if(budget>0){
    overBudget=products.filter(p=>p.total!==null&&p.total>budget).length;
    // Known over-budget offers are excluded; unknown prices remain marked "待核价".
    products=products.filter(p=>p.total===null||p.total<=budget);
  }
  products.sort((a,b)=>{
    const bucket=p=>p.total===null?1:0;
    return bucket(a)-bucket(b)||Number(b.score||0)-Number(a.score||0);
  });
  products=products.slice(0,MAX_SHOP_ITEMS);
  await Promise.all(products.map(async p=>{if(!p.imageUrl)p.imageUrl=await productPageImage(p.sourceUrl);}));
  const advice=await personalizeProducts(products,inputs,env);
  const needs=[item,inputs.target||'',inputs.age?'宝宝月龄 '+inputs.age:'',budget?'总预算 '+budget+' 元':'',
    '数量 '+quantity,inputs.requirements||'',inputs.avoid?'排除 '+inputs.avoid:'']
    .filter(Boolean).join('；');
  const out={
    version:1,kind:'shopping_web',maxResults:MAX_SHOP_ITEMS,searchedAt:new Date().toISOString(),
    query,needs,products,overBudget,conclusion:advice.conclusion||searchError||'已按有来源的商品资料进行对比。',
    searchUrl:'https://search.jd.com/Search?keyword='+encodeURIComponent(item),
    notice:'真实商品页面来自 DeepSeek 联网搜索，必要时补充 DeepSeek Search API。每次最多五款。网页参考价格、图片、库存可能变化；请打开商家详情核实。来源没有明确标价或图片时不虚构。'
  };
  return json({answer:JSON.stringify(out),source:'deepseek',model:'deepseek-flash',productSource:'deepseek_web_search'},200,origin);
}

/* Structured lifestyle and career planning for reliable personal-plan import. */
const CAREER_MODES = ['daily','career','returnwork','learning','balance','goals'];
function validCareerDay(s){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s||'')))return '';
  const d=new Date(s+'T00:00:00Z');
  return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s?s:'';
}
function validCareerTime(s){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s||''))?s:'';}
function cleanCareerText(v,n=250){return String(v??'').trim().slice(0,n);}
async function generateCareerPlan(inputs,env,origin){
  const goal=cleanCareerText(inputs.goal,450);
  if(!goal)return json({error:'请填写本次规划目标'},400,origin);
  const mode=CAREER_MODES.includes(inputs.plan_mode)?inputs.plan_mode:'daily';
  const startDate=validCareerDay(inputs.date)||new Date().toISOString().slice(0,10);
  const start=validCareerTime(inputs.plan_start)||'19:00';
  const minutesIntoDay=Number(start.slice(0,2))*60+Number(start.slice(3));
  const maxMinutes=Math.min(480,1440-minutesIntoDay);
  if(maxMinutes<5)return json({error:'计划开始时间过晚，请提前至少五分钟'},400,origin);
  const duration=Math.max(5,Math.min(maxMinutes,Math.floor(Number(inputs.plan_minutes)||45)));
  const allowed=['personal','rest','learning','career','family'];
  const allowedModes={daily:'日常生活规划',career:'职业发展规划',returnwork:'职场回归计划',learning:'个人能力提升',balance:'生活职业平衡',goals:'我的目标'};
  const prompt='根据用户的真实情况，为生活与职业发展生成可执行的短期行动计划。'+
    '输出且只输出一个 JSON 对象，结构为 {"summary":"约100至220字的整体建议","steps":[{"title":"不超过35字的可执行任务","note":"具体步骤、注意事项及完成标准","category":"career"}]}。'+
    '请给出4至6项具体且不重复的步骤。category仅允许 personal, rest, learning, career, family。'+
    '根据用户的选择聚焦其最重要目标，尊重育儿与休息时间，不承诺招聘岗位、补贴或医学效果。'+
    '日期和时长将由系统安排，请不要在标题中编造具体日期。'+
    '\n模块：'+allowedModes[mode]+'\n用户已填写信息：'+JSON.stringify(inputs).slice(0,3600);
  let ai;
  try {
    const response=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
      body:JSON.stringify({
        model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:1450,
        response_format:{type:'json_object'},
        messages:[
          {role:'system',content:'你是中文生活与职业规划助手。严格输出 JSON，不使用 Markdown 代码围栏。给出有优先级、具体可执行、合理可完成的步骤，避免笼统建议。'},
          {role:'user',content:prompt}
        ]
      }),signal:AbortSignal.timeout(45000)
    });
    if(!response.ok){
      if(response.status===401)return json({error:'DeepSeek API Key 无效'},502,origin);
      if(response.status===402)return json({error:'DeepSeek 账户额度不足'},502,origin);
      if(response.status===429)return json({error:'DeepSeek 请求过于频繁，请稍后重试'},429,origin);
      return json({error:'规划生成暂不可用（'+response.status+'）'},502,origin);
    }
    const result=await response.json();
    const raw=cleanCareerText(result?.choices?.[0]?.message?.content,12000);
    ai=JSON.parse(raw);
  }catch{
    return json({error:'规划生成超时或结果格式有误，请点击重新生成'},502,origin);
  }
  const candidates=Array.isArray(ai?.steps)?ai.steps:[];
  const date0=new Date(startDate+'T00:00:00Z');
  const steps=[],titles=new Set();
  for(const x of candidates){
    const title=cleanCareerText(x?.title,80);
    if(!title||titles.has(title))continue;
    titles.add(title);
    const d=new Date(+date0+steps.length*86400000).toISOString().slice(0,10);
    steps.push({
      title,date:d,start,minutes:duration,
      category:allowed.includes(x?.category)?x.category:(mode==='career'||mode==='returnwork'?'career':mode==='learning'?'learning':'personal'),
      note:cleanCareerText(x?.note,500)||'完成此事项后记录结果并评估下一步。',
      done:false
    });
    if(steps.length===6)break;
  }
  if(!steps.length)return json({error:'本次规划未生成可导入的具体事项，请重新生成'},502,origin);
  const plan={
    kind:'career_plan',mode,summary:cleanCareerText(ai.summary,3000)||'以下计划可逐条或批量导入个人日程，导入后可自行调整。',
    steps,resources:[],searchStatus:'本次未进行实时岗位、课程或政策检索，请核验具体来源。',
    searchedAt:''
  };
  return json({answer:JSON.stringify(plan),source:'deepseek',model:'deepseek-flash'},200,origin);
}

export default {
 async fetch(req, env) {
   const url = new URL(req.url);
   const reqOrigin = req.headers.get('Origin') || '';
   const allowed = String(env.ALLOWED_ORIGIN || '').trim().replace(/\/$/, '');
   const origin = allowed && reqOrigin === allowed ? reqOrigin : '';
   if(url.pathname==='/health' && req.method==='GET') return json({ok:true,service:'MomCare AI gateway'},200,origin);
   if(url.pathname!=='/api/chat') return json({error:'路径不存在'},404,origin);
   if(!origin && url.pathname==='/api/chat') return json({error:'请求来源未授权，请检查 ALLOWED_ORIGIN'},403);
   if(req.method==='OPTIONS') return new Response(null,{status:204,headers:{
     'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type',
     'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Max-Age':'3600','Vary':'Origin'
   }});
   if(req.method!=='POST') return json({error:'仅支持 POST'},405,origin);
   if(!env.DEEPSEEK_API_KEY || !allowed) return json({error:'服务尚未完成 DeepSeek 密钥或允许来源配置'},503,origin);
   // 公开比赛体验，无需访问码。保留来源检查与可选的 Cloudflare AI_LIMITER 限流。
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
   if(kind==='return') return generateCareerPlan(inputs,env,origin);
   let detail=JSON.stringify(inputs);
   if(detail.length>6500) detail=detail.slice(0,6500);
   const storyLengths={'简短（约150字）':150,'标准（约300字）':300,'稍长（约500字）':500};
   const isStory=kind==='storybook';
   const targetLength=storyLengths[inputs.length]||300;
   const storyGuide=`请只输出一篇完整、原创、适龄的中文小故事，不生成绘本分镜、插图提示词或图片。必须有醒目的故事标题、人物、事件起因、发展与自然结尾。根据用户填写的主角、主题、年龄和启发创作，人物情节连贯，语言生动但不说教。篇幅约${targetLength}个汉字；如提供阅读年龄，控制词汇和情节复杂度。不要声称已生成图片。`;
   const prompt = `当前功能：${AI_TITLES[kind]}。\n用户在表单中提供的内容（JSON）：\n${detail}\n${isStory?storyGuide:'请以该功能目标回应。'}`;
   try {
     const res=await fetch('https://api.deepseek.com/chat/completions',{
       method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
       body: JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:isStory?1050:800,
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