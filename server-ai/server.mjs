/**
 * Node.js 22 adapter for MomCare's existing Cloudflare Worker.
 * For initial testing, Docker Compose exposes this only on host loopback.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import worker from './worker.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.BIND_HOST || '0.0.0.0';
const allowedOrigin = String(process.env.ALLOWED_ORIGIN || '').trim().replace(/\/$/, '');
const demoOrigin = String(process.env.DEMO_ORIGIN || '').trim().replace(/\/$/, '');
const deepseekKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
const maxPerMinute = Math.max(1, Number(process.env.MAX_REQUESTS_PER_MINUTE || 10));
const maxPerDay = Math.max(1, Number(process.env.MAX_REQUESTS_PER_DAY || 100));
const templateHtml = readFileSync(new URL('./index.html',import.meta.url),'utf8');
const oldUrlLine = 'window.MOMCARE_WORKER_URL = "https://momcare-ai-competition.27894827.workers.dev";';
const oldHttpsGuard = "if (!endpoint.startsWith('https://') || endpoint.includes('REPLACE_WITH_YOUR_WORKER')) {";
if(!templateHtml.includes(oldUrlLine) || !templateHtml.includes(oldHttpsGuard)) {
  console.error('MomCare 网页的 AI 配置格式已变化，请更新 server-ai 演示适配器');
  process.exit(1);
}
const exhibitionHtml=templateHtml
  .replace(oldUrlLine,'window.MOMCARE_WORKER_URL = window.location.origin;')
  .replace(oldHttpsGuard,"if (!(endpoint.startsWith('https://') || (window.location.protocol === 'http:' && endpoint === window.location.origin)) || endpoint.includes('REPLACE_WITH_YOUR_WORKER')) {");


if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT 必须为有效的端口号');
  process.exit(1);
}
if (!deepseekKey || !allowedOrigin.startsWith('https://') || (demoOrigin && !/^http:\/\/[\w.:-]+$/.test(demoOrigin))) {
  console.error('请在 server-ai/.env 中配置 DEEPSEEK_API_KEY 和 HTTPS 的 ALLOWED_ORIGIN');
  process.exit(1);
}

const limits = { minuteKey:'', minuteCount:0, dayKey:'', dayCount:0 };
function allowRequest() {
  const current = new Date();
  const minuteKey = current.toISOString().slice(0,16);
  const dayKey = current.toISOString().slice(0,10);
  if (limits.minuteKey !== minuteKey) {
    limits.minuteKey = minuteKey;
    limits.minuteCount = 0;
  }
  if (limits.dayKey !== dayKey) {
    limits.dayKey = dayKey;
    limits.dayCount = 0;
  }
  if (limits.minuteCount >= maxPerMinute || limits.dayCount >= maxPerDay) {
    return false;
  }
  limits.minuteCount++;
  limits.dayCount++;
  return true;
}
function errorResponse(status, message, origin) {
  const headers = {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store'
  };
  if (origin === allowedOrigin) {
    headers['Access-Control-Allow-Origin']=origin;
    headers['Vary']='Origin';
  }
  return new Response(JSON.stringify({error:message}), {status,headers});
}
async function handle(req) {
  const method = String(req.method||'GET').toUpperCase();
  const url = new URL(req.url||'/', 'http://localhost');
  const origin = String(req.headers.origin || '');
  if ((url.pathname === '/demo' || url.pathname === '/demo/') && (method==='GET'||method==='HEAD')) {
    if(!demoOrigin || String(req.headers.host||'') !== new URL(demoOrigin).host) {
      return errorResponse(404,'演示页面未启用或域名不匹配',origin);
    }
    return new Response(method==='HEAD'?null:exhibitionHtml,{
      status:200,
      headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}
    });
  }
  const trustedOrigin=origin===allowedOrigin || (demoOrigin && origin===demoOrigin);
  if (url.pathname === '/api/chat' && method === 'POST' && trustedOrigin) {
    if (!allowRequest()) {
      return errorResponse(429,'今日或当前分钟的 AI 请求额度已用完，请稍后再试',origin);
    }
  }
  const pieces=[];
  let bytes=0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes>12000) {
      return errorResponse(413,'请求内容超过 12KB 限制',origin);
    }
    pieces.push(chunk);
  }
  const headers = new Headers();
  for (const [key,value] of Object.entries(req.headers)) {
    if (value!==undefined) headers.set(key,Array.isArray(value)?value.join(', '):value);
  }
  const request = new Request(url, {
    method,
    headers,
    body: ['GET','HEAD'].includes(method) ? undefined : Buffer.concat(pieces)
  });
  return worker.fetch(request,{
    DEEPSEEK_API_KEY:deepseekKey,
    ALLOWED_ORIGIN:demoOrigin && origin===demoOrigin ? demoOrigin : allowedOrigin
  });
}
const server = createServer(async(req,res)=>{
  try {
    const result = await handle(req);
    const body = Buffer.from(await result.arrayBuffer());
    for (const [key,value] of result.headers.entries()) res.setHeader(key,value);
    res.statusCode=result.status;
    res.end(body);
  } catch (e) {
    console.error('MomCare AI 服务器请求失败:',e?.message||String(e));
    res.writeHead(500,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:'AI 网关内部错误'}));
  }
});
server.listen(port,host,()=>{
  console.log('MomCare AI 已启动，容器监听 '+host+':'+port+'，每日软上限 '+maxPerDay);
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
