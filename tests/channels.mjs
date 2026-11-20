import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generate, kind, models } from '../channels.js';
import { readDraw } from '../core.js';

const base={url:'https://example.invalid/v1',type:'auto',size:'1024x1024',key:'mock',model:'test'};
const png=Buffer.from('89504e470d0a1a0a','hex');
const json=data=>Response.json(data);
const image=()=>new Response(png,{headers:{'content-type':'image/png'}});
async function run(p, routes) {
    let i=0;
    global.fetch=async(url,init)=>{
        const step=routes[i++];assert.ok(step,'unexpected request');
        assert.equal(new URL(url).pathname,step.path);
        step.check?.(init);return step.response();
    };
    const result=await generate({...base,...p},'cat "blue"',new AbortController().signal);
    assert.equal(i,routes.length);assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),png);
}
test('OpenAI compatible result URL never receives bearer key',async()=>{
    await run({},[{path:'/v1/images/generations',check:r=>assert.equal(r.headers.Authorization,'Bearer mock'),response:()=>json({data:[{url:'https://cdn.invalid/output.png'}]})},
        {path:'/output.png',check:r=>assert.equal(r.headers.Authorization,undefined),response:image}]);
});
test('custom JSON preserves quotes and numeric dimensions',async()=>{
    await run({type:'custom',template:'{"text":"{prompt}","width":"{width}"}'},[{path:'/v1',check:r=>assert.deepEqual(JSON.parse(r.body),{text:'cat "blue"',width:1024}),response:image}]);
});
test('ComfyUI submits once, polls and fetches an output',async()=>{
    await run({url:'http://localhost:8188',template:'{"7":{"inputs":{"text":"{prompt}"}}}'},[
        {path:'/prompt',response:()=>json({prompt_id:'job'})},{path:'/history/job',response:()=>json({job:{outputs:{7:{images:[{filename:'g.png',subfolder:'',type:'output'}]}}}})},
        {path:'/view',response:image}]);
});
test('RunningHub v2 polls the submitted task',async()=>{
    await run({url:'https://www.runninghub.cn',workflow:'123',template:'[{"fieldValue":"{prompt}"}]'},[
        {path:'/openapi/v2/run/workflow/123',response:()=>json({taskId:'456'})},
        {path:'/openapi/v2/query',response:()=>json({status:'SUCCESS',results:[{url:'https://cdn.invalid/job.png'}]})},{path:'/job.png',response:image}]);
});
test('NovelAI uses V4 captions and reads first image from zip',async()=>{
    global.window={JSZip:{loadAsync:async()=>({files:{first:{dir:false,name:'0.png',async:async()=>new Blob([png])}}})}};
    await run({url:'https://image.novelai.net',model:'nai-diffusion-4-5-full'},[{path:'/ai/generate-image',
        check:r=>assert.equal(JSON.parse(r.body).parameters.v4_prompt.caption.base_caption,'cat "blue"'),response:()=>new Response('zip fixture')}]);
    delete global.window;
});
test('read retries once, paid request errors do not resubmit',async()=>{
    let calls=0;const signal=new AbortController().signal;
    global.fetch=async()=>{if(++calls===1)throw new TypeError('offline');return json({data:[{id:'model'}]});};
    assert.deepEqual(await models(base,signal),['model']);assert.equal(calls,2);
    calls=0;global.fetch=async()=>{calls++;throw new TypeError('offline');};
    await assert.rejects(generate(base,'cat',signal));assert.equal(calls,1);
});
test('last non-empty draw block can contain newlines',()=>{
    assert.equal(readDraw('text<DRAW>x</Draw><draw>y\nz</draw><draw> </draw>'),'y\nz');
});

test('reseller NAI model uses configured protocol and confirmed model-list URL',async()=>{
    const p={...base,model:'nai-diffusion-4-5-full'};
    assert.equal(kind(p),'openai');
    assert.equal(kind({...p,type:'nai'}),'nai');
    const relay={...p,url:'https://example.invalid/relay'};
    assert.equal(kind(relay),'nai');
    assert.equal(kind({...relay,modelsUrl:relay.url}),'openai');
    assert.equal(kind({...relay,url:relay.url+'/ai/generate-image',modelsUrl:relay.url}),'nai');
    global.fetch=async url=>{assert.equal(new URL(url).pathname,'/relay/models');return json({data:[{id:p.model}]});};
    assert.deepEqual(await models(relay,new AbortController().signal),[p.model]);
    await run({...relay,modelsUrl:relay.url},[{path:'/relay/images/generations',response:()=>json({data:[{b64_json:png.toString('base64')}]})}]);
});
test('native NovelAI relay may return PNG or JSON rather than a ZIP',async()=>{
    const p={url:'https://example.invalid/ai/generate-image',model:'nai-diffusion-4'};
    await run(p,[{path:'/ai/generate-image',response:image}]);
    await run(p,[{path:'/ai/generate-image',response:()=>json({url:'data:image/png;base64,'+png.toString('base64')})}]);
});
test('failed download preserves an openable original and never repeats the paid POST',async()=>{
    const calls=[],stages=[];
    global.fetch=async(url,init)=>{
        calls.push(init.method);
        if(init.method==='POST')return json({data:[{url:'https://cdn.invalid/result.png'}]});
        throw new TypeError('Failed to fetch');
    };
    await assert.rejects(generate(base,'test',new AbortController().signal,s=>stages.push(s)),err=>err.imageUrl==='https://cdn.invalid/result.png');
    assert.deepEqual(stages,['读取渠道回包','下载原图']);assert.deepEqual(calls,['POST','GET','GET']);
});

test('shows upstream 400 details without echoing credentials, prompts or validation inputs',async()=>{
    const signal=new AbortController().signal;
    for(const [body,visible] of [
        [JSON.stringify({error:{param:'size',message:'Unsupported size; use 1024x1024'}}),'size · Unsupported size; use 1024x1024'],
        [JSON.stringify({detail:[{loc:['body','model'],msg:'Field required',input:'PRIVATE'}]}),'body.model · Field required'],
        ['bad model for Bearer TOKEN','bad model for Bearer …'],
        [JSON.stringify({message:'invalid my-key / private prompt'}),'invalid … / …'],
        ['<!DOCTYPE html><title>Bad request</title>','未提供详细原因'],
    ]) {
        let calls=0;
        global.fetch=async()=>{calls++;return new Response(body,{status:400});};
        await assert.rejects(generate({...base,key:'my-key'},'private prompt',signal),err=>err.message.includes(visible) && !err.message.includes('PRIVATE'));
        assert.equal(calls,1);
    }
});
