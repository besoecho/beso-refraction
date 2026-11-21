import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { resolve } from 'node:path';
import { createBackup, restoreBackup } from '../backup.js';
import { db } from '../core.js';

// Point ST_JSZIP to SillyTavern/public/lib/jszip.min.js to exercise its actual ZIP library.
test('full backup restores original bytes, stable references and settings without duplicating photos or exporting keys',{skip:!process.env.ST_JSZIP},async()=>{
    const code=readFileSync(resolve(process.env.ST_JSZIP),'utf8');
    const module={exports:{}};
    runInThisContext('(function(module,exports){'+code+'\n})')(module,module.exports);
    const Zip=module.exports;
    global.window={JSZip:Zip};
    global.confirm=()=>true;
    global.FileReader=class {
        async readAsDataURL(blob){this.result='data:image/png;base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');this.onload();}
    };
    const extensionSettings={};
    global.SillyTavern={getContext:()=>({extensionSettings,saveSettingsDebounced(){},getRequestHeaders:()=>({})})};
    const id='a'.repeat(32),profileId='b'.repeat(32),path='/user/images/beso-refraction/'+id+'.png';
    const img=Buffer.from('89504e470d0a1a0a','hex');
    let uploads=0;
    global.fetch=async(url,options)=>{
        if(url===path)return new Response(img);
        assert.equal(url,'/api/images/upload');uploads++;
        const data=JSON.parse(options.body);assert.equal(data.image,img.toString('base64'));
        return Response.json({path:'/user/images/beso-refraction/'+data.filename+'.png'});
    };
    const settings=db();
    settings.profiles.push({id:profileId,key:'NEVER-EXPORT',type:'openai',url:'https://example.invalid/v1',model:'model',size:'1024x1024',name:'画画'});
    settings.album.push({id,card:'card/a',chat:'chat',anchor:'floor',swipe:1,time:new Date().toISOString(),path,prompt:'晚霞'});
    settings.activeId=profileId;settings.auto=true;settings.collapsed=true;
    const zip=await createBackup(()=>{});
    const archive=await Zip.loadAsync(await zip.arrayBuffer());
    assert.ok(!(await archive.file('backup.json').async('string')).includes('NEVER-EXPORT'));
    delete extensionSettings.besoRefraction;
    await restoreBackup(zip,()=>{});await restoreBackup(zip,()=>{});
    assert.equal(uploads,1);
    assert.equal(db().album.length,1);assert.equal(db().profiles.length,1);
    assert.deepEqual([db().album[0].id,db().album[0].anchor,db().album[0].swipe,db().album[0].prompt],[id,'floor',1,'晚霞']);
    assert.equal(db().activeId,profileId);assert.equal(db().auto,true);assert.equal(db().collapsed,true);
});
