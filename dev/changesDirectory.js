// 目录过滤回归：真 Git / 后端 / 界面，假 pi；不向模型发消息。
// npm run web:shot -- --fake-pi --width 1400 --height 900 --script dev/changesDirectory.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SCRATCH_DIR } = require('./harness.js');

module.exports = async page => {
    await page.waitReady();
    const work = path.join(SCRATCH_DIR, 'changes-directory-' + process.pid);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const put = (name, text) => {
        const file = path.join(work, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    };
    const files = ['root.txt', 'Source/one.txt', 'Source/sub/two.txt', 'Source/empty/same.txt', 'SourceExtra/other.txt'];
    for (const file of files) put(file, '原文\n');
    put('.gitignore', 'fake-session-*.jsonl\nAlias\n');
    const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: work, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=dev', '-c', 'user.email=dev@example.invalid', 'commit', '-qm', '基线');
    fs.symlinkSync(path.join(work, 'Source'), path.join(work, 'Alias'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of files.filter(file => !file.includes('/empty/'))) put(file, '修改后\n');
    put('Source/sub/new.txt', '新文件\n');
    fs.rmSync(path.join(work, 'Source/one.txt'));
    const all = ['root.txt', 'Source/one.txt', 'Source/sub/two.txt', 'Source/sub/new.txt', 'SourceExtra/other.txt'].sort();
    const inside = all.filter(file => file.startsWith('Source/'));
    const nested = inside.filter(file => file.startsWith('Source/sub/'));
    const check = (ok, label) => { if (!ok) throw new Error(label); console.log('✓ ' + label); };
    const wait = async (fn, label) => {
        const start = Date.now();
        while (Date.now() - start < 15000) {
            if (await fn()) { console.log('✓ ' + label); return; }
            await page.sleep(120);
        }
        throw new Error('等待超时：' + label);
    };
    const rows = () => page.eval(`return Array.from(document.querySelectorAll('#changePane .change-head')).map(row => row.dataset.path).sort();`);
    const expectRows = (expected, label) => wait(async () => JSON.stringify(await rows()) === JSON.stringify(expected), label);
    const clickDir = async dir => {
        await wait(() => page.eval(`return !!document.querySelector('#dirPane .file-entry[data-path="${dir}"]');`), '目录已列出：' + dir);
        // 窄窗的文件弹窗会盖住清单；这里派 DOM 点击，另验过滤不误关已打开的 diff。
        await page.eval(`document.querySelector('#dirPane .file-entry[data-path="${dir}"]').click(); return true;`);
    };
    const up = () => page.click('#dirPane .file-entry.up');
    await page.eval(`window.acquireVsCodeApi().postMessage({type:'newSessionInWorkspace',path:${JSON.stringify(work)}}); return true;`);
    await wait(() => page.eval(`return document.querySelector('.session-view:not(.off) .session-pane')?.dataset.sessionId;`), '会话已打开');
    await page.waitReady();
    if (!await page.eval(`return document.body.classList.contains('file-open');`)) await page.click('#fileSidebarBtn');
    await expectRows(all, '根目录展示全部改动，含新建与删除文件');
    const sid = await page.eval(`return document.querySelector('.session-view:not(.off) .session-pane').dataset.sessionId;`);
    await page.click('#changePane .change-head[data-path="root.txt"]');
    await wait(() => page.eval(`return !!document.querySelector('#fileBody .diff2-cell');`), '根目录 diff 已打开');
    await clickDir('Source');
    await expectRows(inside, '进入 Source 包含所有下级目录，不误匹配 SourceExtra');
    check(await page.eval(`return document.body.classList.contains('file-view') && !!document.querySelector('#fileBody .diff2-cell');`), '过滤不关闭目录外已打开的 diff');
    await page.click('#fileCloseFile');
    await page.shot('changes-directory-source.png');
    await clickDir('Source/sub');
    await expectRows(nested, '进入更深目录只显示该目录的改动');
    put('Source/sub/live.txt', '刷新新增\n');
    const refreshed = [...nested, 'Source/sub/live.txt'].sort();
    await page.eval(`window.postMessage({type:'changesChanged',sessionId:${JSON.stringify(sid)}}, '*'); return true;`);
    await expectRows(refreshed, '自动刷新仍按当前目录过滤');
    await up();
    await expectRows([...inside, 'Source/sub/live.txt'].sort(), '返回上级同步扩大范围');
    await clickDir('Source/empty');
    await expectRows([], '没有改动的目录不展示其他目录的改动');
    check(await page.eval(`return document.querySelector('#changePane .file-note')?.textContent === '当前目录没有改动。';`), '空目录使用当前目录提示');
    await page.shot('changes-directory-empty.png');
    await up();
    await up();
    await expectRows([...all, 'Source/sub/live.txt'].sort(), '回到根目录恢复全部清单');
    await page.shot('changes-directory-root.png');
    await clickDir('Alias');
    await expectRows([...inside, 'Source/sub/live.txt'].sort(), '目录软链接按后端确认的目标目录过滤');
    await up();
    await expectRows([...all, 'Source/sub/live.txt'].sort(), '软链接目录返回上级恢复全部清单');
    await clickDir('Source');
    await clickDir('Source/sub');
    const other = work + '-other';
    fs.mkdirSync(other, { recursive: true });
    await page.eval(`window.acquireVsCodeApi().postMessage({type:'newSessionInWorkspace',path:${JSON.stringify(other)}}); return true;`);
    await wait(() => page.eval(`return document.querySelector('.session-view:not(.off) .session-pane')?.dataset.sessionId !== ${JSON.stringify(sid)};`), '已切到另一个会话');
    await page.eval(`window.acquireVsCodeApi().postMessage({type:'switchSession',sessionId:${JSON.stringify(sid)}}); return true;`);
    await expectRows(refreshed, '切回会话仍按记住的子目录过滤');
    await page.click('#fileClose');
    await page.eval(`window.postMessage({type:'userMessage',sessionId:${JSON.stringify(sid)},text:'用于验证改动层的假消息'}, '*'); return true;`);
    await page.sleep(200);
    await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const box = await page.eval(`const r=document.getElementById('messages').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.bottom-20};`);
    const touch = (type, y) => page.cdp.send('Input.dispatchTouchEvent', { type,
        touchPoints: type === 'touchEnd' ? [] : [{x:Math.round(box.x),y:Math.round(y),id:1}] });
    await touch('touchStart', box.y);
    for (let step = 1; step <= 12; step++) {
        await touch('touchMove', box.y - step * 22);
        await page.sleep(16);
    }
    await touch('touchEnd', box.y - 264);
    await wait(() => page.eval(`return JSON.stringify(Array.from(document.querySelectorAll('#changeSheetBody .change-head')).map(row=>row.dataset.path).sort()) === ${JSON.stringify(JSON.stringify([...all, 'Source/sub/live.txt'].sort()))};`), '底部改动层仍展示全部改动，不受子目录过滤影响');
    await page.click('#changeSheetClose');
    await page.click('#fileSidebarBtn');
    await page.eval('location.reload(); return true;');
    await page.waitReady();
    await expectRows([...all, 'Source/sub/live.txt'].sort(), '刷新页面回到根目录，清单同步恢复全部');
};
