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