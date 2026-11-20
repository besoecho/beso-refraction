import { delay } from './channels.js';

export const ctx = () => SillyTavern.getContext();
export const db = () => ctx().extensionSettings.besoRefraction ??= {profiles:[], album:[], activeId:'', auto:false, collapsed:false};
export const save = () => ctx().saveSettingsDebounced();
export const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,'0')).join('');
export const q = (s, el=document) => el.querySelector(s);
export const notify = (s, error=false) => window.toastr ? toastr[error?'error':'info'](s,'折光') : console.info('折光',s);
export const drawPattern = /<draw\b[^>]*>([\s\S]*?)<\/draw\s*>/gi;
export function readDraw(text) {
    return [...String(text).matchAll(drawPattern)].map(m=>m[1].trim()).filter(Boolean).at(-1) || '';
}
export const bodyOf = m => String(m?.mes ?? '').replace(drawPattern,'').trim();
export const isAI = m => m && !m.is_user && !m.is_system && Boolean(m.mes?.trim());
export function scope() {
    const c=ctx();
    return {card:c.groupId ? 'group/'+c.groupId : 'card/'+(c.characters?.[c.characterId]?.avatar || c.name2 || ''), chat:c.chatId || c.getCurrentChatId?.() || ''};
}
export const latest = () => ctx().chat.findLastIndex(isAI);
export function capture(i) {
    const message=ctx().chat[i];
    if (!isAI(message) || !scope().chat) throw Error('先打开聊天，等 AI 回复写完');
    return {...scope(),i,message,swipe:message.swipe_id ?? 0,body:bodyOf(message)};
}
export function alive(t) {
    const s=scope(), m=ctx().chat[t.i];
    return s.chat===t.chat && s.card===t.card && m===t.message && (m.swipe_id ?? 0)===t.swipe && bodyOf(m)===t.body;
}
export function versionId(m) { return m?.extra?.besoRefractionId; }
export async function anchor(t) {
    if (!alive(t)) throw Error('目标回复已改变');
    const m=t.message;
    m.extra ??= {};
    const id=m.extra.besoRefractionId ??= uid();
    const info=m.swipe_info?.[t.swipe];
    if (info) (info.extra ??= {}).besoRefractionId=id;
    await ctx().saveChat();
    if (!alive(t)) throw Error('目标回复已改变');
    return id;
}
export const hasHailuo = () => Boolean(q('#ipe-panel, #iped-open-panel'));
export function openHailuo() {
    const opener = q('#iped-open-panel');
    let panel = q('#ipe-panel');
    if (!panel && !opener) throw Error('尚未检测到小海螺');
    // The drawer button toggles the native panel. The floating capsule listens
    // for drag-end events and may not exist when the user hides it.
    if (panel?.dataset.ipeOpen !== '1') opener?.click();
    panel = q('#ipe-panel');
    if (!panel || !q('.ipe-sections', panel)) throw Error('小海螺面板还未就绪，请等待酒馆载入后再试');
    if (panel.dataset.ipeOpen !== '1') {
        panel.classList.add('visible');
        panel.style.setProperty('display','flex','important');
        panel.dataset.ipeOpen = '1';
    }
    panel.classList.add('br-opened-hailuo');
    // Native positioning is inline !important and sometimes refers to the
    // previous capsule position. Anchor this open to the visible viewport.
    if (!panel._brCloseObserver) {
        const geometry = ['left','right','top','bottom','width','height','max-height','transform'];
        const saved = geometry.map(prop=>[prop,panel.style.getPropertyValue(prop),panel.style.getPropertyPriority(prop)]);
        for (const prop of geometry) panel.style.removeProperty(prop);
        const observer = new MutationObserver(()=>{
            if (panel.dataset.ipeOpen === '1' && panel.classList.contains('visible')) return;
            observer.disconnect();
            panel.classList.remove('br-opened-hailuo');
            for (const [prop,value,priority] of saved) {
                if (value && !panel.style.getPropertyValue(prop)) panel.style.setProperty(prop,value,priority);
            }
            delete panel._brCloseObserver;
        });
        observer.observe(panel,{attributes:true,attributeFilter:['data-ipe-open','class']});
        panel._brCloseObserver=observer;
    }
}
export async function extract(t, signal, stage) {
    const existing=readDraw(t.message.mes);
    if (existing) return existing;
    stage('小海螺提取');
    const button=q('#ipe-btn-extract') || q('#iped-btn-extract');
    const inject=q('#ipe-btn-inject') || q('#iped-btn-inject');
    const stop=q('#ipe-btn-stop') || q('#iped-btn-stop');
    if (!button || !inject) throw Error('请先安装并配置小海螺，或在回复中写入 <draw> 提示词');
    const check = () => {
        signal.throwIfAborted();
        if (!alive(t) || ctx().chat.findLastIndex(m=>m && !m.is_user)!==t.i) throw Error('最新回复已改变，已停止提取');
    };
    check();
    if (stop && !stop.disabled || q('#ipe-chat-quick-entry.processing')) throw Error('小海螺正在执行其他提取，请等它完成');
    let injected=false, finished=false;
    try {
        button.click();
        while (true) {
            check();
            const prompt=readDraw(t.message.mes);
            if (prompt) { finished=true; return prompt; }
            const status=(q('#ipe-status') || q('#iped-status'))?.textContent || '';
            if (!injected && !inject.disabled) {
                check();
                stage('提示词注入');
                injected=true;
                inject.click();
            } else if (injected) throw Error('没有读到 <draw>，请检查小海螺的注入模板');
            else if (/失败|错误|未配置|请先|未设置|打断/.test(status) && !q('#ipe-chat-quick-entry.processing') && (!stop || stop.disabled)) throw Error(status);
            await delay(180);
        }
    } finally {
        if (!finished && stop && !stop.disabled) stop.click();
    }
}
export function protectPath(path) {
    if (!/^\/?user\/images\/beso-refraction\/[a-f0-9]{32}\.(png|jpe?g|webp)$/i.test(path)) throw Error('酒馆返回了无法识别的图片路径');
    return path.startsWith('/') ? path : '/'+path;
}
async function localApi(route, body) {
    return fetch('/api/images/'+route,{method:'POST',headers:ctx().getRequestHeaders(),body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
}
export async function upload(blob,id) {
    const bytes = new Uint8Array(await blob.slice(0,12).arrayBuffer());
    let format;
    if (bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71) format='png';
    if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) format='jpg';
    if (String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP') format='webp';
    if (!format) throw Error('接口返回的内容无法识别为 PNG、JPEG 或 WebP');
    const image=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(String(reader.result).split(',')[1]);
        reader.onerror=()=>reject(Error('图片读取失败'));
        reader.readAsDataURL(blob);
    });
    const post=()=>localApi('upload',{image,format,ch_name:'beso-refraction',filename:id});
    let response;
    try { response=await post(); } catch { response=await post(); }
    if (!response.ok) throw Error('酒馆保存图片失败 HTTP '+response.status);
    return protectPath((await response.json()).path);
}
export async function erase(items) {
    if (!items.length || !confirm('永久删除选中的 '+items.length+' 张原图？聊天和相册会一起更新。')) return;
    for (const item of items) {
        const response=await localApi('delete',{path:protectPath(item.path)});
        if (!response.ok && response.status!==404) throw Error('删除失败 HTTP '+response.status);
        db().album=db().album.filter(a=>a.id!==item.id);
        save();
    }
}
