import {backupControls} from './backup.js';
import {generate,kind} from './channels.js';
import {ctx,db,save,uid,q,notify,scope,latest,capture,alive,anchor,versionId,hasHailuo,openHailuo,extract,upload} from './core.js';
import {node,button,connections,activeProfile} from './connections.js';
import {modal,gallery,viewer,saveOriginal} from './gallery.js';

let bar, trigger, shell, status, stage='', job, currentTarget, panel, galleryRefresh, scheduled=false;
const queue=[],states=new Map();
const hooks={refresh,reroll(item,prompt) {
    if(job)throw Error('请等当前任务完成');
    activeProfile();
    void run({source:item,prompt});
}};
function refresh() {renderFloors();galleryRefresh?.();}
function stageText(text) {stage=text; if(status)status.textContent=text; if(trigger){trigger.title=text?'点击停止 · '+text:'生成最新 AI 回复的图片'; trigger.setAttribute('aria-label',trigger.title);trigger.firstChild.className='fa-solid '+(text?'fa-stop':'fa-image');}}
const promptLimits=new Map();
const profileKey=p=>JSON.stringify([p.id,p.url,p.type,p.model]);
function editLongPrompt(task,p,prompt,limit,confirmed) {
    const {dlg,body}=modal('缩短生图提示词');
    const note=node('p',confirmed?'渠道限制合并后的提示词最多 '+limit+' 字符。':'提示词较长，部分 NAI 渠道限制 8000 字符。');
    const edit=node('textarea');
    edit.setAttribute('aria-label','本次生图提示词');edit.rows=8;edit.value=prompt;
    const count=node('p');count.setAttribute('aria-live','polite');
    const submit=()=>{
        const text=edit.value.trim();
        if (!text || (confirmed && [...text].length>limit)) return;
        if (job) throw Error('请等当前生图任务结束');
        if (task.target && !alive(task.target)) throw Error('楼层或 Swipe 已改变，请返回目标楼层重新操作');
        if (profileKey(activeProfile())!==profileKey(p)) throw Error('生图连接已改变，请重新点生图');
        dlg.close();void run({...task,prompt:text,reviewed:true});
    };
    const send=button('用这段生成',submit);
    const cut=button('保留前 '+limit+' 字',()=>{
        edit.value=[...edit.value.trim()].slice(0,limit).join('');update();
    });
    function update() {
        const n=[...edit.value.trim()].length;
        count.textContent=n+' / '+limit+' 字符';
        send.disabled=!n || (confirmed && (n>limit || edit.value.trim()===prompt.trim()));
        cut.disabled=n<=limit;
    }
    edit.oninput=update;update();
    body.append(note,edit,count,cut,send);
}
async function run(task) {
    if(job)return;
    const controller=new AbortController();job=controller;const signal=controller.signal;
    const timeout=setTimeout(()=>controller.abort(Error('任务超时')),180000);
    const t=task.target;currentTarget=t;
    const guard=t && setInterval(()=>{if(!alive(t))controller.abort(Error('目标聊天、楼层或 Swipe 已改变'));},150);
    let p,prompt;
    try {
        stageText('检查连接');
        p=activeProfile(); let meta=task.source;
        if(t) {
            const id=await anchor(t);
            meta={card:t.card,chat:t.chat,anchor:id,swipe:t.swipe};
        }
        prompt=task.prompt || await extract(t,signal,stageText);
        signal.throwIfAborted(); if(t && !alive(t))throw Error('目标回复已改变');
        const known=promptLimits.get(profileKey(p));
        const suggest=kind(p)==='nai' || /^nai[-_ ]/i.test(p.model || '');
        const limit=known ?? (suggest ? 8000 : undefined);
        if (limit && [...prompt].length>limit && (known || !task.reviewed)) {
            editLongPrompt(task,p,prompt,limit,Boolean(known));return;
        }
        stageText('生图请求');
        const result=await generate(p,prompt,signal,stageText);
        signal.throwIfAborted(); if(t && !alive(t))throw Error('目标回复已改变');
        stageText('图片保存');
        const id=uid(),path=await upload(result.blob,id);
        const item={id,path,card:meta.card,chat:meta.chat,anchor:meta.anchor,swipe:meta.swipe,time:new Date().toISOString(),channel:p.name,model:p.model,size:p.size,prompt,seed:result.seed};
        try {
            const bitmap=await createImageBitmap(result.blob);item.size=bitmap.width+'x'+bitmap.height;bitmap.close();
        } catch {}
        db().album.push(item);save();setView(item,{id:item.id,open:!db().collapsed});refresh();
        notify('图片已保存到相册');
    } catch(e) {
        if (!signal.aborted && stage==='生图请求' && e.promptLimit && prompt) {
            promptLimits.set(profileKey(p),e.promptLimit);
            editLongPrompt(task,p,prompt,e.promptLimit,true);
        } else if (!signal.aborted && e.imageUrl) {
            const {body}=modal('下载原图失败');
            body.append(node('p',e.message),node('p','可打开原图手动保存，链接可能会过期。'));
            const link=node('a','打开渠道原图');link.href=e.imageUrl;link.target='_blank';link.rel='noopener noreferrer';body.append(link);
        } else notify(stage+' · '+(signal.aborted?signal.reason?.message:e.message),true);
    }
    finally {
        clearTimeout(timeout);clearInterval(guard);job=null;currentTarget=null;stageText('');
        while(queue.length){const next=queue.shift();if(alive(next)){void run({target:next});break;}}
    }
}
function stop() {if(job && stage!=='图片保存')job.abort(Error('已停止等待，已提交的渠道任务可能仍会运行'));}
function auto(i) {
    if(!db().auto || Number(i)!==latest())return;
    const t=capture(Number(i));
    const same=other=>other && other.message===t.message && other.swipe===t.swipe && other.body===t.body;
    if(job) {if(!same(currentTarget) && !queue.some(same))queue.push(t);}
    else void run({target:t});
}
function panelOpen(tab='生图连接') {
    if(panel?.open){panel.focus();return;}
    const {dlg,body}=modal('折光');panel=dlg;
    const nav=node('nav'),page=node('div',undefined,'br-page');body.append(nav,page);
    function show(label){
        galleryRefresh=null;page.replaceChildren();page.dataset.tab=label;
        for(const b of nav.children)b.setAttribute('aria-pressed',String(b.textContent===label));
        if(label==='相册')galleryRefresh=gallery(page,hooks);
        else if(label==='生图连接')connections(page);
        else {
            for(const [k,l] of [['auto','每条新 AI 回复自动生图'],['collapsed','新图默认收起']]){
                const row=node('label',l,'br-switch'),input=node('input');input.type='checkbox';input.checked=Boolean(db()[k]);
                input.onchange=()=>{db()[k]=input.checked;save();if(k==='auto' && !input.checked)queue.length=0;};row.prepend(input);page.append(row);
            }
            page.append(node('p','使用自动生图时，请在小海螺关闭它自己的自动提取。','br-note'));
            backupControls(page,()=>{refresh();if(page.isConnected && page.dataset.tab==='设置')show('设置');});
        }
    }
    for(const [label,icon] of [['生图连接','fa-plug'],['相册','fa-images'],['设置','fa-sliders']]) {
        const tab=button(label,()=>show(label));
        const glyph=node('i',undefined,'fa-solid '+icon);glyph.setAttribute('aria-hidden','true');
        tab.prepend(glyph);nav.append(tab);
    }
    dlg.addEventListener('close',()=>{galleryRefresh=null;panel=null;});
    show(tab);
}
const groupKey=i=>JSON.stringify([i.card,i.chat,i.anchor,i.swipe]);
function viewState(item) {
    const key=groupKey(item);
    if(!states.has(key)){let stored;try{stored=JSON.parse(sessionStorage.getItem('br-view/'+key));}catch{}states.set(key,stored || {open:!db().collapsed,id:item.id});}
    return states.get(key);
}
function setView(item,state){const key=groupKey(item);states.set(key,state);try{sessionStorage.setItem('br-view/'+key,JSON.stringify(state));}catch{}}
function floorBox(items) {
    const last=items.at(-1),st=viewState(last),wrap=node('details',undefined,'br-floor');
    wrap.open=st.open;
    const summary=node('summary'),img=node('img'),area=node('div',undefined,'br-floor-body'),nav=node('div',undefined,'br-actions');
    let pos=items.findIndex(i=>i.id===st.id);if(pos<0)pos=items.length-1;
    const draw=()=>{img.src=items[pos].path;summary.textContent='楼层图片　'+(pos+1)+' / '+items.length;setView(last,{open:wrap.open,id:items[pos].id});};
    const move=step=>{pos=(pos+step+items.length)%items.length;draw();};
    const big=button('',()=>viewer(items[pos],()=>items,hooks));big.title='看大图';img.alt='点击查看楼层原图';big.append(img);
    let start;big.ontouchstart=e=>{start=e.touches[0].clientX;};big.ontouchend=e=>{const dx=e.changedTouches[0].clientX-start;if(Math.abs(dx)>45){if(e.cancelable)e.preventDefault();move(dx>0?-1:1);}};
    if(items.length>1)nav.append(button('‹ 上一张',()=>move(-1)),button('下一张 ›',()=>move(1)));
    nav.append(button('保存原图',()=>saveOriginal(items[pos])));area.append(big,nav);wrap.append(summary,area);
    wrap.ontoggle=()=>{if(wrap.isConnected)setView(last,{open:wrap.open,id:items[pos].id});};draw();return wrap;
}
function renderFloors() {
    const s=scope(),groups=new Map();
    for(const a of db().album){if(a.chat!==s.chat||a.card!==s.card)continue;const k=groupKey(a);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(a);}
    for(const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const m=ctx().chat[Number(el.getAttribute('mesid'))],id=versionId(m),target=q('.mes_block',el) || el;
        const items=id && groups.get(groupKey({...s,anchor:id,swipe:m.swipe_id??0}));
        const old=q('.br-floor',el);if(!items){old?.remove();continue;}
        const signature=items.map(i=>i.id).join(',');
        if(old?.dataset.items===signature)continue;
        const next=floorBox(items);next.dataset.items=signature;old?.remove();target.append(next);
    }
    if(shell){const missing=!hasHailuo();shell.setAttribute('aria-disabled',String(missing));shell.title=missing?'未检测到小海螺':'打开小海螺';}
}
function later(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;renderFloors();});}
function jump(bottom) {
    const chat=q('#chat'),bounds=chat.getBoundingClientRect(),line=bounds.top+Math.min(70,bounds.height*.18);
    const messages=[...chat.querySelectorAll('.mes[mesid]')];
    const el=messages.find(e=>e.getBoundingClientRect().bottom>line && e.getBoundingClientRect().top<bounds.bottom);
    if(el){const r=el.getBoundingClientRect();chat.scrollBy({top:bottom?r.bottom-bounds.bottom:r.top-bounds.top,behavior:'smooth'});}
}
function init() {
    const chat=q('#chat');if(!chat || q('#br-bar'))return;
    const c=ctx(),settings=c.extensionSettings;
    const regexes=settings.regex??=[];
    if(!regexes.some(r=>r.id==='cbbb3763-3691-438f-841b-a01136bb3283')){
        regexes.push({id:'cbbb3763-3691-438f-841b-a01136bb3283',scriptName:'折光 · 隐藏楼层提示词',findRegex:'/<draw\\b[^>]*>[\\s\\S]*?<\\/draw\\s*>/gi',replaceString:'',trimStrings:[],placement:[2],disabled:false,markdownOnly:true,promptOnly:false,runOnEdit:true,substituteRegex:0,minDepth:null,maxDepth:null});save();
    }
    bar=node('div');bar.id='br-bar';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','折光');
    function icon(title,cls,fn){const b=button('',fn);b.append(node('i',undefined,'fa-solid '+cls));b.title=title;b.setAttribute('aria-label',title);bar.append(b);return b;}
    icon('折光主页','fa-house',()=>panelOpen());
    trigger=icon('生成最新 AI 回复的图片','fa-image',()=>{if(job){stop();return;} const stream=ctx().streamingProcessor;if(stream && !stream.isFinished && !stream.isStopped){notify('等这条 AI 回复写完再生图');return;} if(!db().profiles.length){panelOpen('生图连接');return;}const t=capture(latest());void run({target:t});});
    shell=icon('打开小海螺','fa-water',openHailuo);shell.firstChild.remove();shell.textContent='🐚';
    status=node('span','','br-status');status.setAttribute('aria-live','polite');bar.append(status);
    icon('当前楼层顶端','fa-arrow-up',()=>jump(false));icon('当前楼层底端','fa-arrow-down',()=>jump(true));
    chat.before(bar);
    for(const k of ['CHAT_CHANGED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED','MORE_MESSAGES_LOADED']){
        if(c.eventTypes[k])c.eventSource.on(c.eventTypes[k],later);
    }
    c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED,(i)=>{try{auto(i);}catch(e){notify(e.message,true);}});
    new MutationObserver(changes=>{if(changes.some(r=>[...r.addedNodes].some(n=>n.nodeType===1 && (n.matches('.mes,.mes_block') || n.querySelector('.mes')))))later();}).observe(chat,{childList:true,subtree:true});
    renderFloors();setTimeout(later,2500);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
