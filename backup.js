import {db,save,uid,protectPath,upload,notify} from './core.js';
import {zipLibrary} from './channels.js';
import {node,button,fileBlob,plain,validate} from './connections.js';

const fileId=/^[a-f0-9]{32}$/i;
let busy=false;

export async function createBackup(progress) {
    const Zip=await zipLibrary(), zip=new Zip();
    const {profiles,album,activeId,auto,collapsed}=db();
    const snapshot={
        format:'beso-refraction',version:1,activeId,auto,collapsed,
        profiles:profiles.map(p=>({...plain(p),id:p.id})),
        album:album.map(a=>({...a})),
    };
    for (const [i,item] of snapshot.album.entries()) {
        progress('正在收集原图 '+(i+1)+' / '+snapshot.album.length);
        const path=protectPath(item.path);
        const response=await fetch(path);
        if (!response.ok) throw Error('一张原图读取失败，备份未完成（HTTP '+response.status+'）');
        zip.file('images/'+item.id+'.'+path.split('.').pop(),await response.arrayBuffer());
    }
    zip.file('backup.json',JSON.stringify(snapshot));
    return zip.generateAsync({type:'blob'});
}
function checkItems(items) {
    if (!Array.isArray(items) || items.some(a=>!a || !fileId.test(a.id)) ||
        new Set(items.map(a=>a.id)).size!==items.length) throw Error('备份中的记录编号无效');
}
export async function restoreBackup(file,progress) {
    const Zip=await zipLibrary(),zip=await Zip.loadAsync(await file.arrayBuffer());
    const manifest=zip.file('backup.json');
    if (!manifest) throw Error('请选择折光设置页导出的备份 ZIP');
    const data=JSON.parse(await manifest.async('string'));
    if (data?.format!=='beso-refraction' || data.version!==1 ||
        typeof data.auto!=='boolean' || typeof data.collapsed!=='boolean') throw Error('不支持这个备份格式');
    checkItems(data.profiles);checkItems(data.album);
    const profiles=data.profiles.map(source=>{
        const p={...plain(source),id:source.id};validate(p);return p;
    });
    const pictures=data.album.map(item=>{
        const path=protectPath(item.path);
        const entry=zip.file('images/'+item.id+'.'+path.split('.').pop());
        if (!entry || !['card','chat','anchor','time','prompt'].every(k=>typeof item[k]==='string') ||
            !Number.isInteger(item.swipe)) throw Error('备份缺少图片或楼层信息');
        const {id,card,chat,anchor,swipe,time,prompt,channel,model,size,seed}=item;
        return {entry,record:{id,card,chat,anchor,swipe,time,prompt,channel,model,size,seed}};
    });
    if (!confirm('导入 '+profiles.length+' 套连接、'+pictures.length+' 张图片和插件设置？同编号连接将恢复为备份版本，已有图片会跳过。')) return false;
    // Checkpoint restored images individually so a reconnect and retry resumes.
    let restored=0;
    try {
        for (const [i,{entry,record}] of pictures.entries()) {
            progress('正在恢复原图 '+(i+1)+' / '+pictures.length);
            if (db().album.some(a=>a.id===record.id)) continue;
            const path=await upload(await entry.async('blob'),uid());
            db().album.push({...record,path});save();restored++;
        }
    } catch(e) {throw Error('已恢复 '+restored+' 张，重新导入可继续。'+e.message);}
    const current=db();
    const byId=new Map(current.profiles.map(p=>[p.id,p]));
    for (const p of profiles) byId.set(p.id,p);
    current.profiles=[...byId.values()];
    if (byId.has(data.activeId)) current.activeId=data.activeId;
    current.auto=data.auto;current.collapsed=data.collapsed;save();return true;
}
export function backupControls(page,refresh) {
    const group=node('div',undefined,'br-backup'),actions=node('div',undefined,'br-actions');
    const file=node('input');file.type='file';file.accept='.zip';file.hidden=true;
    const status=node('p','','br-note');status.setAttribute('aria-live','polite');
    const progress=text=>{status.textContent=text;};
    async function perform(action) {
        if (busy) return notify('另一项备份操作正在进行');
        busy=true;exportBtn.disabled=importBtn.disabled=true;
        try {await action();}
        catch(e){progress(e.message);notify(e.message,true);}
        finally{busy=false;exportBtn.disabled=importBtn.disabled=false;}
    }
    const exportBtn=button('导出备份',()=>perform(async()=>{
        const blob=await createBackup(progress);
        fileBlob(blob,'折光备份-'+new Date().toISOString().slice(0,10)+'.zip');progress('备份已生成');
    }));
    const importBtn=button('导入备份',()=>file.click());
    file.onchange=()=>{const chosen=file.files?.[0];file.value='';if(chosen)void perform(async()=>{
        if(await restoreBackup(chosen,progress)){refresh();notify('已恢复折光备份');}
    });};
    actions.append(exportBtn,importBtn);group.append(node('h3','数据备份'),node('p','包含连接、插件设置、相册原图与提示词。API Key 只保存在本机。','br-note'),actions,file,status);
    page.append(group);
}
