// 排队消息行内修改 / 取消回归：假数据，不向模型发消息。
// npm run web:shot -- --fake-pi --script dev/queueActions.js
const { openSessionIn } = require('./harness.js');
module.exports = async (page) => {
    await page.waitReady();
    const check = (ok, text) => { if (!ok) throw new Error(text); console.log('✓ ' + text); };
    const sid = await page.eval(`return document.querySelector('.session-view:not(.off) .session-pane').dataset.sessionId;`);
    const width = await page.eval('return innerWidth;');
    const background = '后台命令 #4 跑完了（退出码 0，用了 9 秒）\n完整命令与输出保留在这里\n第三行\n第四行';
    const long = '与 ARM 最终对照，并按 prepare→preaccept_check→publish_batch 实验接收，最后给出闭环原因，或下一步明确的文件修改点。';
    const rows = [background, long, background];
    const post = async (msgs) => { await page.eval(`for (const m of ${JSON.stringify(msgs)}) window.postMessage(m, '*'); return true;`); await page.sleep(150); };
    const snapshot = (steering, followUp, revision, editable = true) => ({type:'queueUpdate',sessionId:sid,steering,followUp,revision,editable});
    const change = value => page.eval(`const area=document.querySelector('#queueBar .qb-edit-input'); area.value=${JSON.stringify(value)}; area.dispatchEvent(new Event('input', {bubbles:true})); return true;`);
    await page.eval(`const api = window.acquireVsCodeApi(); window.__queueApi = api; window.__queueOrig = api.postMessage; window.__queueSent = []; api.postMessage = msg => { if (msg.type === 'queueAction') { window.__queueSent.push(msg); } else window.__queueOrig(msg); }; return true;`);
    try {
        await post([snapshot(rows, ['子会话完成结果'], 10)]);
        check(await page.eval(`return document.querySelectorAll('#queueBar .qb-action').length === 8;`), 'steering 与 followUp 每条都有两颗按钮');
        check(await page.eval(`return Array.from(document.querySelectorAll('#queueBar .qb-action')).every(b => { const r=b.getBoundingClientRect(); const svg=b.querySelector('svg').getBoundingClientRect(); return r.right <= innerWidth && r.width >= 28 && svg.width === 16 && !b.disabled; });`), '窄屏按钮不被挤走，图标不被内边距挤小');
        await page.click('#queueBar .qb-head');
        check(await page.eval(`return document.querySelector('#queueBar .qb-body').textContent === ${JSON.stringify(background)};`), '摘要展开可看完整后台结果');
        await page.shot(`queue-actions-${width}.png`);

        await page.click('#queueBar .qb-block[data-index="2"][data-kind="steering"] .qb-cancel');
        let request = await page.eval('return window.__queueSent.at(-1);');
        check(request.kind === 'steering' && request.index === 2 && request.text === background && request.revision === 10 && request.sessionId === sid, '重复原文也按版本与索引区分');
        check(await page.eval(`return Array.from(document.querySelectorAll('#queueBar .qb-action')).every(b => b.disabled);`), '等待后端时不可重复操作');
        await post([snapshot(rows.slice(0, 2), ['子会话完成结果'], 11), {...request,type:'queueActionResult',success:true}]);
        check(await page.eval(`return document.querySelectorAll('#queueBar .qb-block').length === 3;`), '取消只移除目标项，其他消息保留');

        await page.type('已有草稿');
        await page.click('#queueBar .qb-edit');
        check(await page.eval(`return window.__queueSent.length === 1 && document.querySelector('#queueBar .qb-edit-input').value === ${JSON.stringify(background)} && document.querySelector('#input').value === '已有草稿';`), '点击铅笔只进入行内编辑，保留多行原文，不搬到主输入框');
        await change(long);
        await page.shot(`queue-edited-${width}.png`);
        await page.eval(`const b=document.querySelector('#queueBar .qb-save'); b.click(); b.click(); return true;`);
        request = await page.eval('return window.__queueSent.at(-1);');
        check(request.act === 'edit' && request.text === background && request.replacement === long && request.revision === 11, '保存发送原文、替换内容与原队列版本');
        check(await page.eval(`return window.__queueSent.length === 2 && document.querySelector('#queueBar .qb-edit-input').readOnly && document.querySelector('#queueBar .qb-discard').disabled;`), '保存等待期间只请求一次，不能重复保存或丢弃');
        const result = {...request,type:'queueActionResult',success:true,text:long};
        await post([snapshot([long, rows[1]], ['子会话完成结果'], 12), result, result]);
        check(await page.eval(`return !document.querySelector('#queueBar .qb-edit-input') && document.querySelector('#queueBar .qb-preview').textContent === ${JSON.stringify(long)} && document.querySelector('#input').value === '已有草稿';`), '成功后恢复摘要，原位修改、不影响主草稿，重复回执无副作用');

        await page.click('#queueBar .qb-edit');
        await change('不保存的修改');
        await page.click('#queueBar .qb-discard');
        check(await page.eval(`return window.__queueSent.length === 2 && document.querySelector('#queueBar .qb-preview').textContent === ${JSON.stringify(long)};`), '× 放弃修改不调用后端，原队列消息不变');
        await page.click('#queueBar .qb-edit');
        await change('   ');
        check(await page.eval(`return document.querySelector('#queueBar .qb-save').disabled;`), '空白修改不能保存');
        await page.press('Escape');
        check(await page.eval(`return !document.querySelector('#queueBar .qb-edit-input');`), 'Esc 放弃行内编辑');

        await page.click('#queueBar .qb-block[data-kind="followUp"] .qb-edit');
        await change('修改后的子会话结果');
        await page.click('#queueBar .qb-save');
        request = await page.eval('return window.__queueSent.at(-1);');
        await openSessionIn(page);
        await page.type('另一个会话的草稿');
        await post([snapshot([long, rows[1]], ['修改后的子会话结果'], 13), {...request,type:'queueActionResult',success:true}]);
        check(await page.eval(`return document.querySelector('#input').value === '另一个会话的草稿' && !document.querySelector('#queueBar .qb-edit-input');`), '切会话后的回执不写错输入框');
        await page.eval(`window.acquireVsCodeApi().postMessage({type:'switchSession',sessionId:${JSON.stringify(sid)}}); return true;`);
        await page.sleep(300);
        await post([snapshot([long], [], 14)]);
        check(await page.eval(`return document.querySelector('#input').value === '已有草稿' && !document.querySelector('#queueBar .qb-edit-input');`), '原会话草稿仍保留，成功编辑已收尾');

        await page.click('#queueBar .qb-edit');
        await change('投递后也要保留供复制的编辑文字');
        await post([snapshot([], [], 15)]);
        check(await page.eval(`return document.querySelector('#queueBar .qb-edit-input').value === '投递后也要保留供复制的编辑文字' && document.querySelector('#queueBar .qb-save').disabled && document.querySelector('#queueBar .qb-edit-error').textContent.includes('队列已变化');`), '编辑期间消息被投递则禁用保存，保留文字供复制，绝不重发');
        await page.click('#queueBar .qb-discard');
        check(await page.eval(`return document.querySelector('#queueBar').classList.contains('hidden');`), '放弃陈旧编辑后回到空队列');
        await post([snapshot([long], [], 16)]);
        await page.click('#queueBar .qb-edit');
        await change('失败时的编辑文字');
        await page.press('Enter');
        request = await page.eval('return window.__queueSent.at(-1);');
        check(request.replacement === '失败时的编辑文字', 'Enter 保存行内内容，不触发主输入框发送');
        await post([{...request,type:'queueActionResult',success:false,error:'排队消息已经变化，无法修改。'}]);
        check(await page.eval(`return document.querySelector('#queueBar .qb-edit-input').value === '失败时的编辑文字' && document.querySelector('#queueBar .qb-edit-error').textContent.includes('无法修改') && document.querySelector('#input').value === '已有草稿';`), '失败保留行内输入并提示原因，不污染主输入框');
        await page.click('#queueBar .qb-discard');
        await post([snapshot(['旧 pi 上的排队消息'], [], 0, false)]);
        check(await page.eval(`return Array.from(document.querySelectorAll('#queueBar .qb-action')).every(b => b.disabled);`), '不支持逐条操作时关闭按钮，绝不清空重排');
    } finally {
        await page.eval(`window.__queueApi.postMessage = window.__queueOrig; return true;`);
    }
};
