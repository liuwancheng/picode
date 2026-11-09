// 代码段复制回归：假消息，不调模型。
// npm run web:shot -- --fake-pi --script dev/codeCopy.js
module.exports = async (page) => {
    await page.waitReady();
    const code = 'import ida_hexrays\nprint("中文 <tag> & test")\nida_hexrays.clear_cached_cfuncs()';
    const post = (messages) => page.eval(`for (const m of ${JSON.stringify(messages)}) window.postMessage(m, "*"); return true;`);
    await post([
        { type: "userMessage", text: "等自动分析完成后，执行：" },
        { type: "assistantFull", text: '```python\n' + code + '\n```\n\n然后定位函数，按 F5。\n\n```\n没有语言标签的代码\n```\n\n    缩进代码\n\n行内 `code` 不加按钮。' },
    ]);
    await page.sleep(300);
    const root = '.session-view:not(.off) .msg.assistant';
    const selector = root + ' .code-copy';
    const check = (ok, why) => { if (!ok) throw new Error(why); };
    check(await page.eval(`return document.querySelectorAll(${JSON.stringify(selector)}).length === 3;`), '带语言、无语言、缩进代码都应有按钮');
    check(await page.eval(`return document.querySelector(${JSON.stringify(root + ' pre code')}).textContent === ${JSON.stringify(code + '\n')};`), '高亮后的原文应保留中文与特殊字符');
    check(await page.eval(`const svg = document.querySelector(${JSON.stringify(selector + ' svg')}); const r = svg.getBoundingClientRect(); return r.width >= 16 && r.height >= 16;`), '复制图标不可被通用按钮内边距挤小');
    const size = await page.eval('return innerWidth;');

    // 用浏览器自己的剪贴板验一次（不是插件里的 VS Code 剪贴板）。
    await page.cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    const point = await page.eval(`const btn = document.querySelector(${JSON.stringify(selector)}); btn.scrollIntoView({block:'center'}); const r = btn.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};`);
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await page.sleep(100);
    const copied = await page.eval(`return navigator.clipboard.readText();`);
    check(copied.replace(/\r\n/g, '\n') === code + '\n', '复制内容不应带语言标签或按钮文字，实际：' + JSON.stringify(copied));
    check(await page.eval(`return document.querySelector(${JSON.stringify(selector)}).title === '已复制';`), '复制成功反馈');
    await page.shot(`code-copy-success-${size}.png`);
    await page.sleep(1600);

    // 模拟局域网 HTTP：Clipboard API 不可用，检查兼容路径与失败反馈。
    await page.eval(`
        window.__clipboard = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        window.__execCommand = document.execCommand;
        document.execCommand = (cmd) => { window.__copied = document.activeElement.value; return cmd === 'copy'; };
        document.querySelector('#input').focus();
        return true;
    `);
    await page.click(selector);
    await page.sleep(100);
    check(await page.eval(`return window.__copied === ${JSON.stringify(code + '\n')} && document.activeElement.id === 'input';`), '兼容复制应保留原文、恢复焦点');
    await page.sleep(1600);
    await page.eval(`document.execCommand = () => false; return true;`);
    await page.click(selector);
    await page.sleep(100);
    check(await page.eval(`return document.querySelector(${JSON.stringify(selector)}).title.includes('复制失败');`), '失败不可假报成功');
    await page.eval(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__clipboard }); document.execCommand = window.__execCommand; return true;`);
    await page.sleep(1600);

    await post([{ type: 'userMessage', text: '流式输出也能复制：' }, { type: 'assistantDelta', delta: '```cpp\nif (value < 2) {\n' }]);
    await page.sleep(300);
    await post([{ type: 'assistantDelta', delta: '    return value;\n}\n```\n\n完成。' }]);
    await page.sleep(300);
    check(await page.eval(`const blocks = document.querySelectorAll(${JSON.stringify(root + ' .md-code')}); const last = blocks[blocks.length - 1]; return last && last.querySelectorAll('.code-copy').length === 1 && last.querySelector('code').textContent.includes('return value;');`), '流式尾块应保留高亮与单个按钮');
    await page.eval(`document.querySelectorAll(${JSON.stringify(root + ' .md-code')})[0].scrollIntoView({block:'start'}); return true;`);
    await page.shot(`code-copy-${size}.png`);
    console.log('代码段复制：原文、浏览器剪贴板、兼容路径、反馈、流式输出全部通过');
};
