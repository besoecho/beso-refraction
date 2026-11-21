"""Offline Chromium integration test. Requires Python playwright and a Chromium binary."""
import base64
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j34kAAAAASUVORK5CYII='
HTML = """
<meta charset=utf-8><link rel=stylesheet href=/style.css>
<div id=sheld><div id=chat><div class=mes mesid=0><div class=mes_block>楼层</div></div></div></div>
<script>
const events={}, c={chatId:'chat',name2:'Alice',characterId:0,characters:[{avatar:'a.png'}],
chat:[{mes:'story <draw>a cat</draw>',swipe_id:0,extra:{},swipe_info:[{extra:{}}]}],
extensionSettings:{},saveChat:async()=>{},saveSettingsDebounced(){},getRequestHeaders:()=>({'Content-Type':'application/json'}),
eventSource:{on:(k,fn)=>(events[k]??=[]).push(fn)},eventTypes:Object.fromEntries(['MESSAGE_RECEIVED','CHAT_CHANGED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED','MORE_MESSAGES_LOADED'].map(k=>[k,k]))};
window.SillyTavern={getContext:()=>c};window.emit=(k,i)=>events[k]?.forEach(fn=>fn(i));
window.toastr={info:console.log,error:console.warn};
</script><script type=module src=/index.js></script>
"""


class Server(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_):
        pass

    def result(self, data, mime='application/json'):
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/fixture':
            return self.result(HTML.encode(), 'text/html; charset=utf-8')
        if self.path == '/v1/models':
            return self.result(b'{"data":[{"id":"test-model"}]}')
        if self.path.startswith('/user/images/'):
            return self.result(base64.b64decode(PNG), 'image/png')
        super().do_GET()

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/v1/images/generations':
            assert self.headers['Authorization'] == 'Bearer mock-only'
            prompts.append(payload['prompt'])
            self.result(json.dumps({'data':[{'b64_json':PNG}]}).encode())
        elif self.path == '/api/images/upload':
            assert payload['image'] == PNG
            self.result(json.dumps({'path':'/user/images/beso-refraction/'+payload['filename']+'.png'}).encode())
        elif self.path == '/api/images/delete':
            self.result(b'{}')
        else:
            self.send_error(404)


prompts = []
server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:' + str(server.server_port)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':390,'height':844}, has_touch=True)
    errors = []
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.goto(base+'/fixture')
    # Native opening is asynchronous and does not depend on an internal container class.
    page.evaluate("""() => {
        const native=document.createElement('button');native.id='iped-open-panel';native.hidden=true;
        const clip=document.createElement('div');clip.id='ipe-clip';
        clip.style.cssText='position:relative;height:36px;overflow:hidden;transform:translateZ(0);background:#8a7aa0';
        document.body.append(clip,native);
        native.onclick=()=>{setTimeout(()=>{
            let panel=document.getElementById('ipe-panel');
            if(!panel){
                panel=document.createElement('div');panel.id='ipe-panel';panel.style.display='none';
                panel.innerHTML='<button>关闭小海螺</button><div class="ipe-body">提示词设置</div>';
                panel.firstChild.onclick=()=>{panel.classList.remove('visible');panel.dataset.ipeOpen='0';panel.style.display='none';};
                document.getElementById('ipe-clip').append(panel);
            }
            panel.classList.add('visible');panel.dataset.ipeOpen='1';
            panel.style.setProperty('display','flex','important');panel.style.setProperty('width','2px','important');
        },60);};
        document.body.append(native);
    }""")
    for _ in range(2):
        page.get_by_role('button',name='打开小海螺').click()
        expect(page.locator('#ipe-panel')).to_be_visible()
        page.get_by_role('button',name='打开小海螺').click()
        expect(page.locator('#ipe-panel')).to_be_visible()
        bounds=page.locator('#ipe-panel').bounding_box()
        assert bounds and bounds['width']>300 and bounds['height']>200
        assert page.evaluate("""() => {const p=document.getElementById('ipe-panel'),r=p.getBoundingClientRect();
            const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===p || p.contains(hit);}""")
        assert page.locator('#ipe-chat-quick-entry').count()==0
        page.get_by_text('关闭小海螺').click()
        expect(page.locator('#ipe-panel')).to_be_hidden()
    # An existing panel can still open when the native drawer button is absent.
    page.evaluate("document.getElementById('iped-open-panel').remove()")
    page.get_by_role('button',name='打开小海螺').click()
    expect(page.locator('#ipe-panel')).to_be_visible()
    page.get_by_text('关闭小海螺').click()
    expect(page.locator('#ipe-panel')).to_be_hidden()
    page.get_by_role('button',name='折光主页').click()
    for label,value in [('连接名称','我的接口'),('API 地址',base+'/v1'),('API Key','mock-only')]:
        page.get_by_label(label,exact=label=='模型').fill(value)
    page.get_by_role('button',name='获取模型').click()
    expect(page.locator('.br-note')).to_contain_text('1 个模型')
    page.get_by_label('选择模型').select_option('__br_manual__')
    expect(page.get_by_label('模型',exact=True)).to_be_visible()
    assert page.locator('.br-field').evaluate_all("""rows => {const i=rows.findIndex(r=>r.firstChild?.textContent==='模型');
        const p=rows.findIndex(r=>r.firstChild?.textContent==='选择模型');return i>=0 && p>i;}""")
    page.get_by_label('选择模型').select_option('test-model')
    page.get_by_label('预设尺寸').select_option('2160x3840')
    page.get_by_role('button',name='保存并使用').click()
    assert page.evaluate('c.extensionSettings.besoRefraction.profiles[0].model')=='test-model'
    assert page.evaluate('c.extensionSettings.besoRefraction.profiles[0].size')=='2160x3840'
    page.get_by_role('button',name='关闭').click()
    def generate(count):
        page.get_by_role('button',name='生成最新 AI 回复的图片').click()
        page.wait_for_function('n=>c.extensionSettings.besoRefraction.album.length===n',arg=count)
    generate(1)
    generate(2)
    expect(page.locator('.br-floor summary')).to_contain_text('2 / 2')
    page.get_by_text('‹ 上一张').click()
    expect(page.locator('.br-floor summary')).to_contain_text('1 / 2')
    page.locator('.br-floor summary').click()
    assert not page.locator('.br-floor').evaluate('e=>e.open')
    page.evaluate("c.chat[0].swipe_id=1;emit('MESSAGE_SWIPED')")
    expect(page.locator('.br-floor')).to_have_count(0)
    page.evaluate("c.chat[0].swipe_id=0;emit('MESSAGE_SWIPED')")
    expect(page.locator('.br-floor')).to_have_count(1)
    assert not page.locator('.br-floor').evaluate('e=>e.open')
    page.get_by_role('button',name='折光主页').click()
    page.get_by_role('button',name='相册',exact=True).click()
    expect(page.locator('.br-tile')).to_have_count(2)
    page.locator('.br-tile button').first.click()
    expect(page.locator('.br-full')).to_be_visible()
    page.on('dialog',lambda d:d.accept())
    page.get_by_role('button',name='删除',exact=True).click()
    expect(page.locator('.br-tile')).to_have_count(1)
    page.locator('.br-full').get_by_text('关闭').click()
    page.get_by_role('button',name='设置').click()
    page.get_by_label('每条新 AI 回复自动生图').check()
    page.locator('.br-dialog[open]').get_by_role('button',name='关闭',exact=True).click()
    page.evaluate("""() => {
        c.chat[0].mes='other story';c.chat[0].swipe_id=1;
        for(const id of ['ipe-btn-extract','ipe-btn-inject','ipe-btn-stop']) {
            const b=document.createElement('button');b.id=id;document.body.append(b);
        }
        const btn=id=>document.getElementById('ipe-btn-'+id);
        let extractionTarget=0;
        btn('stop').disabled=btn('inject').disabled=true;
        btn('extract').onclick=()=>{
            extractionTarget=c.chat.findLastIndex(m=>m && !m.is_user && !m.is_system && m.mes.trim());
            btn('stop').disabled=false;setTimeout(()=>{btn('inject').disabled=false;btn('stop').disabled=true;},50);
        };
        btn('inject').onclick=()=>{c.chat[extractionTarget].mes+=' <draw>'+(extractionTarget===0?'night scene':'next scene')+'</draw>';btn('inject').disabled=true;};
        emit('MESSAGE_RECEIVED',0);
        setTimeout(()=>{
            c.chat.push({mes:'following story',swipe_id:0,extra:{},swipe_info:[{extra:{}}]});
            emit('MESSAGE_RECEIVED',1);
        },20);
    }""")
    page.wait_for_function('c.extensionSettings.besoRefraction.album.length===3')
    assert prompts == ['a cat','a cat','night scene','next scene']
    assert page.evaluate("""() => {const a=c.extensionSettings.besoRefraction.album;
        return a[1].anchor===c.chat[0].extra.besoRefractionId && a[2].anchor===c.chat[1].extra.besoRefractionId;}""")
    page.evaluate("""() => {
        const i=c.chat.length-1;c.chat[i].mes='another story';emit('MESSAGE_RECEIVED',i);
        setTimeout(()=>{c.chatId='elsewhere';emit('CHAT_CHANGED');},25);
    }""")
    page.wait_for_timeout(400)
    assert len(prompts)==4 and not errors, errors
    browser.close()
server.shutdown()
print('PASS · profile, key-free export, manual, automatic, extraction, stale target, gallery deletion, swipe, collapse')
