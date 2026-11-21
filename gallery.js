import {db, scope, protectPath, erase, notify} from './core.js';
import {node,button,option,download,fileBlob} from './connections.js';
import {zipLibrary} from './channels.js';

export function modal(title,full=false) {
    const dlg=node('dialog',undefined,'br-dialog'+(full?' br-full':''));
    const head=node('header'),body=node('section'); head.append(node('strong',title),button('关闭',()=>dlg.close()));
    dlg.append(head,body);document.body.append(dlg);dlg.onclose=()=>dlg.remove();dlg.showModal();return {dlg,body,head};
}
function filename(item) {return '折光-'+item.time.slice(0,10)+'-'+item.id.slice(0,10)+'.'+item.path.split('.').pop();}
export const saveOriginal=item=>download(protectPath(item.path),filename(item));
function pinch(view,image) {
    let zoom=1,x=0,y=0,distance=0;
    const pointers=new Map();
    const gap=()=>{const [a,b]=pointers.values();return Math.hypot(a.x-b.x,a.y-b.y);};
    const paint=()=>{
        const limitX=Math.max(0,(image.clientWidth*zoom-view.clientWidth)/2);
        const limitY=Math.max(0,(image.clientHeight*zoom-view.clientHeight)/2);
        x=Math.min(limitX,Math.max(-limitX,x));y=Math.min(limitY,Math.max(-limitY,y));
        image.style.transform='translate('+x+'px,'+y+'px) scale('+zoom+')';
    };
    view.onpointerdown=e=>{view.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===2)distance=gap();};
    view.onpointermove=e=>{
        const old=pointers.get(e.pointerId); if(!old)return;
        pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
        if(pointers.size===2) {const next=gap(); if(distance)zoom=Math.min(5,Math.max(1,zoom*next/distance));distance=next;}
        else if(zoom>1){x+=e.clientX-old.x;y+=e.clientY-old.y;}paint();
    };
    view.onpointerup=view.onpointercancel=e=>pointers.delete(e.pointerId);
    view.ondblclick=()=>{zoom=zoom===1?2:1; x=y=0;paint();};
}
export function viewer(first, group, hooks) {
    const {dlg,body}=modal('原图',true);let item=first;
    function draw() {
        const images=group().filter(a=>db().album.some(b=>b.id===a.id));
        if (!images.length){dlg.close();return;}
        let at=images.findIndex(a=>a.id===item.id); if(at<0)at=0;item=images[at];
        body.replaceChildren();
        const area=node('div',undefined,'br-stage'),img=node('img');img.src=protectPath(item.path);img.alt='生成原图';img.draggable=false;area.append(img);pinch(area,img);
        const nav=node('div',undefined,'br-actions');
        const move=n=>{item=images[(at+n+images.length)%images.length];draw();};
        nav.append(button('‹ 上一张',()=>move(-1)),node('span',(at+1)+' / '+images.length),button('下一张 ›',()=>move(1)),button('保存原图',()=>saveOriginal(item)),button('删除',async()=>{try{await erase([item]);}finally{hooks.refresh();draw();}}));
        const info=node('details');info.append(node('summary','提示词与生成信息'));
        const date=new Date(item.time).toLocaleString();info.append(node('p',[item.channel,item.model,item.size,date,item.seed!=null?'Seed '+item.seed:''].filter(Boolean).join(' · ')));
        const edit=node('textarea');edit.value=item.prompt;edit.rows=4;info.append(edit);
        const reroll=s=>{if(!s.trim())throw Error('提示词为空');hooks.reroll(item,s.trim());dlg.close();};
        info.append(button('复制提示词',async()=>{await navigator.clipboard.writeText(edit.value);notify('已复制');}),button('原词再生成',()=>reroll(item.prompt)),button('按编辑内容生成',()=>reroll(edit.value)));
        body.append(area,nav,info);
    }
    draw();
}
export function gallery(root,hooks) {
    let filter='chat';const checked=new Set();
    function draw() {
        root.replaceChildren();
        const select=node('select');for(const [v,l] of [['chat','当前聊天'],['card','当前角色卡'],['all','全部图片']])option(select,v,l);
        select.value=filter;select.onchange=()=>{filter=select.value;checked.clear();draw();};
        const s=scope(),items=db().album.filter(a=>filter==='all'||a.card===s.card&&(filter==='card'||a.chat===s.chat)).slice().reverse();
        const grid=node('div',undefined,'br-grid'),actions=node('div',undefined,'br-actions');
        const selected=()=>items.filter(i=>checked.has(i.id));
        const batch=button('下载所选',async()=>{
            const list=selected();if(list.length===1)return saveOriginal(list[0]);
            const Zip=await zipLibrary(),zip=new Zip();
            for(const item of list){const r=await fetch(protectPath(item.path));if(!r.ok)throw Error('原图读取失败');zip.file(filename(item),await r.arrayBuffer());}
            fileBlob(await zip.generateAsync({type:'blob'}),'折光-相册.zip');
        });
        const del=button('删除所选',async()=>{try{await erase(selected());}finally{hooks.refresh();}});
        const toggle=()=>{batch.disabled=del.disabled=!selected().length;};toggle();actions.append(select,batch,del);root.append(actions,grid);
        if(!items.length)root.append(node('p','这里还没有图片。回到聊天，点导航栏的生图键试试。'));
        for(const item of items) {
            const tile=node('div',undefined,'br-tile'),pic=node('img');pic.src=protectPath(item.path);pic.loading='lazy';pic.alt=item.prompt;
            const open=button('',()=>viewer(item,()=>items.filter(i=>i.card===item.card && i.chat===item.chat && i.anchor===item.anchor && i.swipe===item.swipe),hooks));open.append(pic);open.title='看大图';
            const box=node('input');box.type='checkbox';box.setAttribute('aria-label','选择图片');box.checked=checked.has(item.id);
            box.onchange=()=>{if(box.checked)checked.add(item.id);else checked.delete(item.id);toggle();};
            tile.append(open,box);grid.append(tile);
        }
    }
    draw();return draw;
}
