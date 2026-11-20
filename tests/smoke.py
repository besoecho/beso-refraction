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
    page.get_by_role('button',name='折光主页').click()
    for label,value in [('连接名称','我的接口'),('API 地址',base+'/v1'),('API Key','mock-only'),('模型','test-model')]:
        page.get_by_label(label,exact=label=='模型').fill(value)
    page.get_by_role('button',name='测试 / 获取模型').click()
    expect(page.locator('.br-note')).to_contain_text('1 个模型')
    page.get_by_role('button',name='保存并使用').click()
    with page.expect_download() as downloaded:
        page.get_by_role('button',name='导出连接').click()
    exported = Path(downloaded.value.path()).read_text()
    assert 'mock-only' not in exported and '我的接口' in exported
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
    expect(page.locator('.br-tile')).to_have_count(2)
    page.locator('.br-tile button').first.click()
    expect(page.locator('.br-full')).to_be_visible()
    page.on('dialog',lambda d:d.accept())
    page.get_by_role('button',name='删除',exact=True).click()
    expect(page.locator('.br-tile')).to_have_count(1)
    page.locator('.br-full').get_by_text('关闭').click()
    page.get_by_role('button',name='设置').click()
    page.get_by_label('每条新 AI 回复自动生图').check()
    page.get_by_text('关闭').click()
    page.evaluate("""() => {
        c.chat[0].mes='other story';c.chat[0].swipe_id=1;
        for(const id of ['ipe-btn-extract','ipe-btn-inject','ipe-btn-stop']) {
            const b=document.createElement('button');b.id=id;document.body.append(b);
        }
        const btn=id=>document.getElementById('ipe-btn-'+id);
        btn('stop').disabled=btn('inject').disabled=true;
        btn('extract').onclick=()=>{btn('stop').disabled=false; setTimeout(()=>{btn('inject').disabled=false;btn('stop').disabled=true;},50);};
        btn('inject').onclick=()=>{c.chat[0].mes+=' <draw>night scene</draw>';btn('inject').disabled=true;};
        emit('MESSAGE_RECEIVED',0);
    }""")
    page.wait_for_function('c.extensionSettings.besoRefraction.album.length===2')
    assert prompts == ['a cat','a cat','night scene']
    page.evaluate("""() => {
        c.chat[0].mes='another story';emit('MESSAGE_RECEIVED',0);
        setTimeout(()=>{c.chatId='elsewhere';emit('CHAT_CHANGED');},25);
    }""")
    page.wait_for_timeout(400)
    assert len(prompts)==3 and not errors, errors
    browser.close()
server.shutdown()
print('PASS · profile, key-free export, manual, automatic, extraction, stale target, gallery deletion, swipe, collapse')
