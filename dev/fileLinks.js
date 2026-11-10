// 短链接产物发现 + 所在目录按钮整条链回归。假数据，不调用模型；系统打开目录用记录器替换。
// npm run compile && node dev/fileLinks.js [--dark] [--narrow]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pichat-file-links-'));
process.env.PICHAT_HOME = path.join(tmp, 'home');
const cwd = path.join(tmp, 'work');
const other = path.join(tmp, 'other');
fs.mkdirSync(cwd, {recursive:true});
fs.mkdirSync(other, {recursive:true});
fs.writeFileSync(path.join(cwd, '.gitignore'), '/Reverse/_work/\n');
function report(rel, value) {
    const full = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(full), {recursive:true});
    fs.writeFileSync(full, JSON.stringify({value}));
    return full;
}
const target = report('Reverse/_work/session-A/reviews/Checks.tmo.final02.json', 'REPORT-A');
const sameA = report('Reverse/_work/libtmpdb_util/sessions/pi-session-A/' + 'a'.repeat(64) + '/reviews/Same.json', 'SAME-A');
report('Reverse/_work/libtmpdb_util/sessions/pi-session-B/' + 'b'.repeat(64) + '/reviews/Same.json', 'SAME-B');
report('src/example.ts', 'EXAMPLE');
const outside = path.join(tmp, 'outside.json');
fs.writeFileSync(outside, '{}');
const out = path.resolve(__dirname, '../out/server');
const desktop = require(path.join(out, 'desktopNotice.js'));
const folders = [];
desktop.openLocalFolder = async folder => { folders.push(folder); };
const {createHarness, openSessionIn} = require('./harness.js');
const {openPage} = require('./cdp.js');
(async () => {
    const narrow = process.argv.includes('--narrow');
    const dark = process.argv.includes('--dark');
    const harness = createHarness({fakePi:true,cwd,port:0,theme:dark?'dark':'light'});
    let browser;
    try {
        const url = await harness.start();
        browser = await openPage({url,width:narrow?420:1000,height:900,timeoutMs:60000});
        const page=browser.page;
        const wait=async fn=>{const start=Date.now();while(Date.now()-start<20000){if(await fn())return;await page.sleep(100);}throw new Error('等待文件链接状态超时');};
        await page.waitReady();
        const sid=[...harness.host().panels.values()].find(rt=>rt.cwd===cwd).id;
        const responses=[];
        const host=harness.host();
        const post=host.postToOneClient.bind(host);
        host.postToOneClient=(client,msg)=>{responses.push(msg);return post(client,msg);};
        assert.equal(host.knownSessionFiles(sid).some(p=>p.endsWith('Checks.tmo.final02.json')),false);
        await page.eval(`window.postMessage({type:'assistantFull',sessionId:${JSON.stringify(sid)},text:'报告：\u0060reviews/Checks.tmo.final02.json\u0060\\n同名报告：\u0060reviews/Same.json\u0060\\n代码位置：\u0060src/example.ts:299\u0060\\n目录：\u0060Reverse/_work/\u0060'},'*');return true;`);
        await wait(()=>page.eval(`return document.querySelectorAll('.session-view:not(.off) .file-folder').length===3;`));
        assert(await page.eval(`return Array.from(document.querySelectorAll('.file-folder')).every(b=>b.querySelector('svg').getBoundingClientRect().width===13);`));
        await page.sleep(500); // 等消息进入动画结束，截图看常态颜色。
        await page.shot(`file-link-icons-${narrow?'narrow':'wide'}.png`);
        const preview=(name)=>`a.file-link[data-file="${name}"]`;
        const folder=(name)=>`button.file-folder[data-file="${name}"]`;
        await page.click(preview('reviews/Checks.tmo.final02.json'));
        await wait(()=>page.eval(`return document.querySelector('#fileStage')?.textContent.includes('REPORT-A');`));
        assert.equal(fs.existsSync(path.join(cwd,'reviews/Checks.tmo.final02.json')),false);
        await page.shot(`file-link-report-${narrow?'narrow':'wide'}.png`);
        await page.click('#fileCloseFile');
        await page.click(folder('reviews/Checks.tmo.final02.json'));
        await wait(()=>folders.length===1);
        await wait(()=>page.eval(`return !document.querySelector(${JSON.stringify(folder('reviews/Checks.tmo.final02.json'))}).disabled;`));
        assert.equal(folders[0],path.dirname(await fs.promises.realpath(target)));
        assert(await page.eval(`return getComputedStyle(document.getElementById('fileStage')).display==='none';`),'目录按钮不能顺带打开文件预览');

        await page.click(preview('reviews/Same.json'));
        await wait(()=>page.eval(`return document.querySelector('#fileSearchOverlay')?.classList.contains('hidden')===false && document.querySelectorAll('#fileSearchBody .fs-row').length===2;`));
        const candidates=await page.eval(`return Array.from(document.querySelectorAll('#fileSearchBody .fs-row')).map(r=>r.textContent);`);
        assert(candidates.every(p=>p.includes('Reverse/_work/')),'忽略目录候选不可被普通搜索重新过滤掉');
        assert(await page.eval(`return Array.from(document.querySelectorAll('#fileSearchBody .fs-row')).every(r=>r.title===r.textContent && getComputedStyle(r.querySelector('.fs-file-line')).whiteSpace==='normal');`),'长候选显示完整路径、允许折行，不能省略掉区别部分');
        await page.shot(`file-link-candidates-${narrow?'narrow':'wide'}.png`);
        await page.click('#fileSearchBody .fs-row:nth-child(2)');
        await wait(()=>page.eval(`return document.querySelector('#fileStage')?.textContent.includes('SAME-B');`));
        await page.click('#fileCloseFile');
        await page.click(folder('reviews/Same.json'));
        await wait(()=>page.eval(`return document.querySelector('#fileSearchOverlay')?.classList.contains('hidden')===false && document.querySelectorAll('#fileSearchBody .fs-row').length===2;`));
        await page.click('#fileSearchBody .fs-row');
        await wait(()=>folders.length===2);
        assert.equal(folders[1],path.dirname(await fs.promises.realpath(sameA)));

        // 候选请求在发出前延迟，切到另一 cwd 后再交给真后端。
        await page.eval(`const api=window.acquireVsCodeApi();window.__api=api;window.__orig=api.postMessage;window.__held=[];api.postMessage=m=>{if(m.type==='pathCandidates'){window.__held.push(m);}else window.__orig(m);};return true;`);
        await page.click(preview('reviews/Checks.tmo.final02.json'));
        const held=await page.eval(`return window.__held[0];`);
        assert.equal(held.sessionId,sid);
        await openSessionIn(page,other);
        await wait(()=>page.eval(`return document.getElementById('sessionName').dataset.cwd===${JSON.stringify(other)};`));
        await page.eval(`window.__api.postMessage=window.__orig;for(const m of window.__held)window.__orig(m);return true;`);
        await wait(()=>responses.some(r=>r.type==='pathCandidatesResult'&&r.requestId===held.requestId));
        const reply=responses.find(r=>r.type==='pathCandidatesResult'&&r.requestId===held.requestId);
        assert.equal(reply.sessionId,sid);
        assert.deepEqual(reply.candidates,['Reverse/_work/session-A/reviews/Checks.tmo.final02.json']);
        await page.sleep(200);
        assert(await page.eval(`return getComputedStyle(document.getElementById('fileStage')).display==='none';`),'切会话后不能弹出原会话文件或拿新 cwd 打开');
        for(const [requestId,sessionId,p] of [[9001,sid,outside],[9002,'missing',target]]){
            await page.eval(`window.acquireVsCodeApi().postMessage({type:'revealFileFolder',requestId:${requestId},sessionId:${JSON.stringify(sessionId)},path:${JSON.stringify(p)}});return true;`);
            await wait(()=>responses.some(r=>r.type==='fileFolderResult'&&r.requestId===requestId));
            assert.equal(responses.find(r=>r.type==='fileFolderResult'&&r.requestId===requestId).ok,false);
        }
        assert.equal(folders.length,2,'目录外及不存在的会话不能触发系统目录打开');
        console.log('通过：忽略的 bash 产物短链接、目录图标、多候选原路径选择、来源会话绑定、陈旧回执丢弃、目录边界。系统目录打开已用记录器替换。');
    } finally {
        if(browser)await browser.close();
        await harness.stop();
        fs.rmSync(tmp,{recursive:true,force:true});
    }
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
