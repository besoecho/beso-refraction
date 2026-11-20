import {db, save, uid, notify} from './core.js';
import {kind, models} from './channels.js';

export function node(tag,text,cls) {
    const el=document.createElement(tag);
    if (text!==undefined) el.textContent=text;
    if (cls) el.className=cls;
    return el;
}
export function button(label, action) {
    const b=node('button',label);
    b.type='button';
    b.onclick=async()=>{try { await action(); } catch(e) { notify(e.message,true); }};
    return b;
}
export function option(list,value,label) {
    const opt=node('option',label); opt.value=value; list.append(opt);
}
export function download(href,name) {
    const anchor=node('a'); anchor.href=href; anchor.download=name; document.body.append(anchor); anchor.click(); anchor.remove();
}
export function fileBlob(blob,name) {
    const url=URL.createObjectURL(blob); download(url,name); setTimeout(()=>URL.revokeObjectURL(url),60000);
}
const blank=()=>({id:uid(),name:'',url:'',model:'',size:'1024x1024',type:'auto',template:'',workflow:'',proxy:false});
const keyName=p=>'beso-refraction/key/'+p.id+'/'+new URL(p.url).origin;
export function activeProfile() {
    const p=db().profiles.find(v=>v.id===db().activeId);
    if (!p) throw Error('先到「主页 → 生图连接」保存一套连接');
    return {...p,key:localStorage.getItem(keyName(p)) || ''};
}
function plain(p) {
    const obj=blank();
    for (const k of ['name','url','model','size','type','workflow','template']) if (typeof p[k]==='string') obj[k]=p[k].trim();
    obj.proxy=p.proxy===true;
    return obj;
}
function validate(p) {
    if (!p.name || !p.url) throw Error('请填写连接名称和 API 地址');
    const url=new URL(p.url);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('地址需要以 http(s) 开头，密钥请单独填写');
    if (!/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(p.size)) throw Error('尺寸格式例如 1024x1024');
    const type=kind(p);
    if (!['nai','comfy','openai','custom','runninghub'].includes(type)) throw Error('接口类型无效');
    if (['nai','openai'].includes(type) && !p.model) throw Error('请填写模型');
    if (['comfy','custom','runninghub'].includes(type)) {
        JSON.parse(p.template);
        if (!p.template.includes('{prompt}')) throw Error('模板中需要 {prompt}');
    }
    if (type==='runninghub' && !p.workflow) throw Error('请填写工作流 ID');
}
// Pixel sizes offered by 智绘姬 across its general and workflow connections.
const sizeGroups = [
    ['4K', ['3840x2160','2160x3840','2880x2880','3312x2480','2480x3312','3520x2336','3840x1920']],
    ['2K', ['2560x1440','1440x2560','2048x2048','2048x1536','1536x2048','2048x1152']],
    ['1080P', ['1920x1080','1080x1920']],
    ['1K / 标清', ['1024x1024','1280x720','720x1280','1152x896','896x1152','768x768','512x512']],
    ['扩散模型常用', ['640x640','512x768','768x512','1216x832','832x1216']],
];
const modelLists = new Map();
const modelListKey = p => JSON.stringify([p.id,p.url.trim(),p.type]);

export function connections(root) {
    let draft={...(db().profiles.find(p=>p.id===db().activeId) || blank())};
    function draw() {
        root.replaceChildren();
        const list=node('select');
        for(const p of db().profiles) option(list,p.id,p.name);
        option(list,'','＋ 新连接'); list.value=db().profiles.some(p=>p.id===draft.id)?draft.id:'';
        list.onchange=()=>{const p=db().profiles.find(p=>p.id===list.value); draft={...(p || blank())}; if(p){db().activeId=p.id;save();} draw();};
        root.append(list);
        function field(label,el,value) {
            const row=node('label',label,'br-field'); row.append(el); root.append(row); el.value=value; return row;
        }
        function input(label,k,placeholder='',type='text') {
            const el=node('input'); el.type=type; el.placeholder=placeholder; el.autocomplete='off';
            field(label,el,draft[k] || ''); el.oninput=()=>draft[k]=el.value; return el;
        }
        input('连接名称','name','我的生图连接');
        const url=input('API 地址','url','https://…/v1');
        const secret=node('input'); secret.type='password';secret.autocomplete='off';
        let initialOrigin='';
        try {initialOrigin=new URL(draft.url).origin;} catch {}
        field('API Key（保存在当前浏览器）',secret,initialOrigin ? localStorage.getItem(keyName(draft)) || '' : '');
        const model=input('模型','model');
        const picker=node('select');
        const pickerRow=field('选择模型',picker,'');
        model.parentElement.before(pickerRow);
        function showModels(names) {
            picker.replaceChildren();
            option(picker,'','请选择模型');
            for(const name of names) option(picker,name,name);
            option(picker,'__br_manual__','手动填写…');
            pickerRow.hidden=!names.length;
            picker.value=names.includes(draft.model) ? draft.model : draft.model ? '__br_manual__' : '';
            model.parentElement.hidden=names.length>0 && picker.value!=='__br_manual__';
        }
        picker.onchange=()=>{
            const manual=picker.value==='__br_manual__';
            model.parentElement.hidden=!manual;
            if (manual) {model.focus();model.select();}
            else {draft.model=picker.value;model.value=picker.value;}
        };
        const sizePicker=node('select');
        const allSizes=sizeGroups.flatMap(([,values])=>values);
        for (const [label,values] of sizeGroups) {
            const group=node('optgroup');group.label=label;
            for (const size of values) {
                const [w,h]=size.split('x').map(Number);
                option(group,size,size.replace('x',' × ')+' · '+(w===h?'方图':w>h?'横图':'竖图'));
            }
            sizePicker.append(group);
        }
        option(sizePicker,'custom','自定义尺寸…');
        field('预设尺寸',sizePicker,allSizes.includes(draft.size)?draft.size:'custom');
        const sizeInput=input('自定义宽 × 高','size','例如 1024x1536');
        sizeInput.parentElement.hidden=sizePicker.value!=='custom';
        sizePicker.onchange=()=>{
            const custom=sizePicker.value==='custom';
            sizeInput.parentElement.hidden=!custom;
            if(custom){sizeInput.focus();sizeInput.select();}
            else {draft.size=sizePicker.value;sizeInput.value=draft.size;}
        };
        const workflow=input('工作流 ID','workflow');
        const template=node('textarea'); template.rows=5;
        field('请求模板 JSON（用 {prompt} 代表提示词）',template,draft.template); template.oninput=()=>draft.template=template.value;
        const details=node('details');details.append(node('summary','接口识别与连接方式')); root.append(details);
        const proto=node('select');
        for(const [v,l] of Object.entries({auto:'自动识别',openai:'OpenAI 兼容',nai:'NovelAI',comfy:'ComfyUI',runninghub:'RunningHub',custom:'自定义 HTTP'})) option(proto,v,l);
        details.append(proto);proto.value=draft.type;
        const route=node('label','通过酒馆代理连接 '); const proxy=node('input'); proxy.type='checkbox';proxy.checked=draft.proxy;route.prepend(proxy);details.append(route);
        proxy.onchange=()=>draft.proxy=proxy.checked;
        const refresh=()=>{let k;try{k=kind(draft);}catch{} workflow.parentElement.hidden=k!=='runninghub';template.parentElement.hidden=!['runninghub','comfy','custom'].includes(k);};
        let requestNumber=0;
        const resetModels=()=>{requestNumber++;showModels(modelLists.get(modelListKey(draft)) || []);};
        proto.onchange=()=>{draft.type=proto.value;refresh();resetModels();};
        url.addEventListener('input',()=>{let origin='';try{origin=new URL(draft.url).origin;}catch{} if(origin!==initialOrigin){secret.value='';initialOrigin=origin;}refresh();resetModels();});
        refresh();resetModels();
        const note=node('p','','br-note');
        const actions=node('div',undefined,'br-actions');root.append(actions,note);
        actions.append(button('保存并使用',()=>{
            const p={...plain(draft),id:draft.id};validate(p);
            if(secret.value.trim()) localStorage.setItem(keyName(p),secret.value.trim()); else localStorage.removeItem(keyName(p));
            const i=db().profiles.findIndex(o=>o.id===p.id); if(i<0) db().profiles.push(p); else db().profiles[i]=p;
            db().activeId=p.id;save();draft={...p};draw();notify('已使用「'+p.name+'」');
        }),button('测试 / 获取模型',async()=>{
            const run=++requestNumber;
            note.textContent='正在测试…'; const p={...draft,key:secret.value.trim()};
            try {
                let names;
                try { names=await models(p,AbortSignal.timeout(15000)); }
                catch(e) {
                    if (run!==requestNumber || !picker.isConnected) return;
                    if (p.proxy || !(e instanceof TypeError || e.name==='TimeoutError')) throw e;
                    names=await models({...p,proxy:true},AbortSignal.timeout(15000));
                    if (run!==requestNumber || !picker.isConnected) return;
                    proxy.checked=true; draft.proxy=true;
                }
                if (run!==requestNumber || !picker.isConnected) return;
                names=[...new Set(names.filter(n=>typeof n==='string' && n.length>0))];
                modelLists.set(modelListKey(p),names);showModels(names);
                note.textContent=names.length?'已取得 '+names.length+' 个模型，可点模型框选取。':'已连接';
            } catch(e) {if(run===requestNumber && picker.isConnected){details.open=true;note.textContent=e.message;}}
        }),button('导出连接',()=>{
            const clean=db().profiles.map(p=>{const copy=plain(p); delete copy.id;return copy;});
            fileBlob(new Blob([JSON.stringify(clean,null,2)],{type:'application/json'}),'折光-连接.json');
        }),button('导入连接',()=>files.click()));
        const files=node('input');files.type='file';files.accept='.json';files.hidden=true;root.append(files);
        files.onchange=async()=>{
            try {const set=JSON.parse(await files.files[0].text());if(!Array.isArray(set)||!set.length)throw Error('请选择连接配置数组');
                const profiles=set.map(plain);profiles.forEach(validate);db().profiles.push(...profiles);draft=profiles[0];db().activeId=draft.id;save();draw();notify('已导入，请补填 API Key');
            }catch(e){notify(e.message,true);}
        };
    }
    draw();
}
