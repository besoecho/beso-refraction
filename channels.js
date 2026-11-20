export function kind(p) {
    if (p.type && p.type !== 'auto') return p.type;
    const u = new URL(p.url);
    if (/(^|\.)novelai\.net$/.test(u.hostname) || /\/ai\/generate-image\/?$/i.test(u.pathname)) return 'nai';
    if (/(^|\.)runninghub\.(ai|cn)$/.test(u.hostname)) return 'runninghub';
    if (u.port === '8188' || /(?:^|[./-])comfyui(?:[./-]|$)/i.test(u.hostname+u.pathname)) return 'comfy';
    if (p.modelsUrl === p.url.trim() || /\/(v1|images\/generations)\/?$/i.test(u.pathname)) return 'openai';
    if (/^nai-diffusion-/i.test(p.model || '')) return 'nai';
    return 'openai';
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function safeUrl(value) {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('请填写 HTTP(S) 地址');
    return u.href;
}
function rejectionDetail(raw, key, prompt) {
    let reason;
    try {
        const data=JSON.parse(raw);
        if (typeof data==='string') reason=data;
        else {
            const field=data?.error?.param;
            reason=[data?.error?.message, data?.message, data?.detail, data?.error, data?.error?.code]
                .find(v=>typeof v==='string' && v.trim());
            if (!reason && Array.isArray(data?.detail)) {
                const issue=data.detail.find(v=>typeof v?.msg==='string');
                if (issue) reason=[issue.loc?.join?.('.'),issue.msg].filter(Boolean).join(' · ');
            }
            if (reason && typeof field==='string') reason=field+' · '+reason;
        }
    } catch {
        if (!/^\s*[<{[]/.test(raw)) reason=raw;
    }
    if (!reason) return '';
    for (const secret of [key,prompt]) {
        if (typeof secret==='string' && secret) reason=reason.replaceAll(secret,'…');
    }
    return reason.replace(/\bBearer\s+[\w.~+/=-]+/gi,'Bearer …')
        .replace(/https?:\/\/\S+/gi,'[地址]').replace(/\s+/g,' ').trim().slice(0,260);
}
async function requestOnce(p, url, signal, body, authenticated) {
    const remote = safeUrl(url);
    const headers = {};
    if (authenticated && p.key && new URL(remote).origin === new URL(p.url).origin) headers.Authorization = 'Bearer ' + p.key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const throughProxy = p.proxy || (globalThis.location?.protocol === 'https:' && new URL(remote).protocol === 'http:');
    const destination = throughProxy ? '/proxy/' + encodeURIComponent(remote) : remote;
    if (throughProxy) headers['X-CSRF-Token'] = SillyTavern.getContext().getRequestHeaders()['X-CSRF-Token'];
    const response = await fetch(destination, {method: body === undefined ? 'GET' : 'POST', headers, signal,
        redirect: authenticated && p.key ? 'error' : 'follow', credentials: throughProxy ? 'same-origin' : 'omit',
        body: body === undefined ? undefined : JSON.stringify(body)});
    if (!response.ok) {
        const raw=await response.text().catch(()=>'');
        if (throughProxy && response.status===404 && raw.includes('CORS proxy is disabled')) {
            throw Error('酒馆服务器未启用 CORS 代理，当前代理连接不可用');
        }
        const detail=rejectionDetail(raw,p.key,body?.prompt ?? body?.input);
        throw Error('接口返回 HTTP ' + response.status + (detail?' · '+detail:'（未提供详细原因）'));
    }
    return response;
}
async function request(p, url, signal, body, authenticated = true) {
    const readOnly = body === undefined || (kind(p)==='runninghub' && new URL(url).pathname.endsWith('/openapi/v2/query'));
    if (!readOnly) return requestOnce(p,url,signal,body,authenticated);
    for (let attempt=0; attempt<2; attempt++) {
        const timeout = new AbortController();
        const abort = () => timeout.abort(signal.reason);
        signal.throwIfAborted();
        signal.addEventListener('abort',abort,{once:true});
        const timer = setTimeout(()=>timeout.abort(new DOMException('读取超时','TimeoutError')),20000);
        try { const response = await requestOnce(p,url,timeout.signal,body,authenticated); return new Response(await response.arrayBuffer(),{headers:response.headers,status:response.status}); }
        catch (e) { if (attempt || signal.aborted || (e.name !== 'TimeoutError' && !(e instanceof TypeError))) throw e; }
        finally { clearTimeout(timer); signal.removeEventListener('abort',abort); }
    }
}
export async function zipLibrary() {
    if (!window.JSZip) await import('/lib/jszip.min.js');
    if (!window.JSZip) throw Error('酒馆 ZIP 组件未加载');
    return window.JSZip;
}
function endpoint(p) { return safeUrl(p.url).replace(/\/+$/, ''); }
export async function models(p, signal) {
    const base = endpoint(p), type = kind({...p,model:''});
    if (type === 'openai') {
        const root = base.replace(/\/images\/generations$/, '');
        const data = await (await request(p, root + '/models', signal)).json();
        if (!Array.isArray(data.data)) throw Error('接口未返回模型列表，可手动填写');
        return data.data.map(m => m.id);
    }
    if (type === 'comfy') { await request(p, base + '/system_stats', signal); return []; }
    throw Error('该协议请手动填写模型或工作流，连接将在首次出图时验证');
}
function fillTemplate(template, values) {
    if (Array.isArray(template)) return template.map(x => fillTemplate(x, values));
    if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k,v]) => [k, fillTemplate(v, values)]));
    if (typeof template !== 'string') return template;
    for (const [k,v] of Object.entries(values)) if (template === '{'+k+'}') return v;
    return template.replace(/\{(prompt|model|width|height|seed)\}/g, (_,k) => String(values[k]));
}
function decodeBase64(value) {
    // Some mobile clients block fetch(data:...) even for a successful API result.
    const raw = value.replace(/^data:image\/(?:png|webp|jpe?g);base64,/i,'');
    try {
        const binary=atob(raw);
        const bytes=new Uint8Array(binary.length);
        for(let i=0;i<bytes.length;i++) bytes[i]=binary.charCodeAt(i);
        return new Blob([bytes]);
    } catch { throw Error('渠道返回的图片编码不完整'); }
}
async function downloadResult(p, url, signal, progress, authenticated=false) {
    progress('下载原图');
    const remote=safeUrl(new URL(url, endpoint(p)+'/').href);
    try {
        return await (await request(p,remote,signal,undefined,authenticated)).blob();
    } catch(e) {
        signal.throwIfAborted();
        const err=Error('渠道已返回原图地址，下载失败。'+(e instanceof TypeError?'浏览器未能读取图片。':e.message));
        if (!authenticated) err.imageUrl=remote;
        throw err;
    }
}
async function unpack(p, response, signal, progress) {
    const mime = response.headers.get('content-type') || '';
    if (/image\/(png|jpeg|webp)/.test(mime)) return response.blob();
    const json = await response.json();
    const item = json.data?.[0] ?? json;
    if (item.b64_json) return decodeBase64(item.b64_json);
    if (typeof item.url==='string' && item.url) {
        if (/^data:image\//i.test(item.url)) return decodeBase64(item.url);
        return downloadResult(p,item.url,signal,progress);
    }
    throw Error('接口未返回图片、url 或 b64_json');
}
export async function generate(p, prompt, signal, progress=()=>{}) {
    let base = endpoint(p);
    const type = kind(p);
    if (type === 'nai') base = base.replace(/\/ai\/generate-image$/, '');
    const [width,height] = p.size.split('x').map(Number);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const vars = {prompt,model:p.model,width,height,seed};
    async function post(suffix,body) {
        const route=p.proxy || (globalThis.location?.protocol==='https:' && base.startsWith('http:')) ? '酒馆代理' : '直连';
        try { return await request(p,base+suffix,signal,body); }
        catch(e) {
            signal.throwIfAborted();
            if (!(e instanceof TypeError)) throw e;
            throw Error(route+'未收到渠道响应。请先查这次任务记录，确认后再重试');
        }
    }
    if (type === 'openai' || type === 'custom') {
        const custom = type === 'custom';
        const body = custom ? fillTemplate(JSON.parse(p.template), vars) : {model:p.model,prompt,size:p.size,n:1};
        const suffix = custom || base.endsWith('/images/generations') ? '' : '/images/generations';
        const response=await post(suffix,body);
        progress('读取渠道回包');
        return {blob:await unpack(p,response,signal,progress)};
    }
    if (type === 'nai') {
        const parameters = {params_version:3,width,height,seed,steps:28,scale:5,sampler:'k_euler_ancestral',noise_schedule:'karras',n_samples:1,negative_prompt:''};
        if (/diffusion-4/.test(p.model)) {
            parameters.v4_prompt = {caption:{base_caption:prompt,char_captions:[]},use_coords:false,use_order:true};
            parameters.v4_negative_prompt = {caption:{base_caption:'',char_captions:[]},legacy_uc:false};
        }
        const response = await post('/ai/generate-image',{input:prompt,model:p.model,action:'generate',parameters});
        progress('读取渠道回包');
        if (/^(image\/|application\/json)/i.test(response.headers.get('content-type') || '')) {
            return {blob:await unpack(p,response,signal,progress),seed};
        }
        const zip = await (await zipLibrary()).loadAsync(await response.arrayBuffer());
        const file = Object.values(zip.files).find(f=>!f.dir && /\.(png|webp|jpe?g)$/i.test(f.name));
        if (!file) throw Error('NovelAI 压缩包没有图片');
        return {blob:await file.async('blob'),seed};
    }
    const template = JSON.parse(p.template);
    if (!p.template.includes('{prompt}')) throw Error('工作流需要包含 {prompt}');
    if (type === 'comfy') {
        const {prompt_id:id} = await (await post('/prompt',{prompt:fillTemplate(template,vars)})).json();
        if (!id) throw Error('ComfyUI 未接受工作流');
        progress('查询生图任务');
        while (!signal.aborted) {
            await delay(1200);
            const job = (await (await request(p,base+'/history/'+encodeURIComponent(id),signal)).json())[id];
            if (job?.status?.status_str === 'error') throw Error('ComfyUI 工作流执行失败');
            const img = Object.values(job?.outputs ?? {}).flatMap(o=>o.images ?? []).find(i=>i.type === 'output');
            if (img) return {blob:await downloadResult(p,base+'/view?'+new URLSearchParams(img),signal,progress,true)};
            if (job?.status?.completed) throw Error('工作流没有输出图片');
        }
    } else {
        const {taskId} = await (await post('/openapi/v2/run/workflow/'+encodeURIComponent(p.workflow),{nodeInfoList:fillTemplate(template,vars)})).json();
        if (!taskId) throw Error('RunningHub 未接受工作流');
        progress('查询生图任务');
        while (!signal.aborted) {
            await delay(2000);
            const result = await (await post('/openapi/v2/query',{taskId})).json();
            if (result.status === 'FAILED') throw Error('RunningHub 工作流执行失败');
            if (result.status === 'SUCCESS') return {blob:await downloadResult(p,result.results[0].url,signal,progress)};
        }
    }
    signal.throwIfAborted();
}
