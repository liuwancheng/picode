// 时间行回归：假数据，不向模型发消息。
// npm run web:shot -- --fake-pi --width 1000 --height 1000 --script dev/msgTime.js
module.exports = async page => {
    await page.waitReady();
    const sid = await page.eval(`return document.querySelector('.session-view:not(.off) .session-pane').dataset.sessionId;`);
    const post = async messages => {
        await page.eval(`for (const message of ${JSON.stringify(messages)}) window.postMessage({...message,sessionId:${JSON.stringify(sid)}}, '*'); return true;`);
        await page.sleep(180);
    };
    const check = (ok, label) => { if (!ok) throw new Error(label); console.log('✓ ' + label); };
    const pad = n => String(n).padStart(2, '0');
    const full = ms => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const short = ms => {
        const d = new Date(ms), now = new Date();
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
        const md = `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${hm}`;
        return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
    };
    const now = Date.now();
    const cases = [
        {id:'time-old', at:new Date(new Date().getFullYear()-1, 2, 5, 9, 7, 12).getTime(), question:'历史回答的时间如何显示？', text:'跨年保留完整日期，时间单独一行，不盖住正文。'},
        {id:'time-day', at:now-3*24*3600*1000, question:'同年的其他日期呢？', text:'其他日期显示月日，仍可悬停查看精确到秒的时间。'},
        {id:'time-today', at:now-2*60*1000, question:'请把时间改成单独一行。', text:'已改成常显的居中时间行。\n\n不用停鼠标就能看清回答与下一次提问的交界。'},
        {id:'time-live', question:'没有历史时间的回答呢？', text:'使用这段回答开始显示的时刻，不会是空白或 1970 年。'},
    ];
    const events = cases.flatMap(item => [
        {type:'userMessage',id:item.id+'-user',text:item.question},
        {type:'assistantFull',id:item.id,text:item.text,...(item.at ? {at:item.at} : {})},
    ]);
    await post(events);
    await page.cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:2,y:2,button:'none'});
    const read = id => page.eval(`
        const message=document.querySelector('.session-view:not(.off) .msg.assistant[data-mid="${id}"]');
        const time=message?.querySelector(':scope > .msg-time');
        const body=message?.querySelector(':scope > .md');
        if (!time || !body) return null;
        const style=getComputedStyle(time), row=time.getBoundingClientRect(), mr=message.getBoundingClientRect(), br=body.getBoundingClientRect();
        return {text:time.dataset.time,title:time.title,visible:style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)===1,
            position:style.position,align:style.textAlign,select:style.userSelect,events:style.pointerEvents,
            afterBody:time.previousElementSibling===body,below:row.top>=br.bottom+12,centered:Math.abs((row.left+row.right-mr.left-mr.right)/2)<2,
            inText:message.textContent.includes(time.dataset.time),last:time===message.lastElementChild};
    `);
    for (const item of cases) {
        const got = await read(item.id);
        check(got?.visible, item.id+'：不悬停也常显');
        check(got.afterBody && got.last && got.below && got.position==='static', item.id+'：正文之后独占一行，不覆盖正文');
        check(got.centered && got.align==='center', item.id+'：时间行居中');
        check(got.select==='none' && !got.inText, item.id+'：时间不混入正文复制内容');
        check(got.events!=='none', item.id+'：时间行可悬停查看完整时间');
        if (item.at) check(got.text===short(item.at) && got.title===full(item.at), item.id+'：短时间和完整时间正确');
        else check(Math.abs(Date.parse(got.title.replace(' ', 'T'))-now)<60000, '缺失历史时间时使用当前时刻');
    }
    check(await page.eval('return !document.querySelector(".msg-copy");'), '没有恢复旧复制按钮');
    const before = await read('time-today');
    await post([{type:'assistantFull',id:'time-today',text:cases[2].text+'\n\n同一条回答重新绘制。',at:cases[2].at}]);
    const updated = await read('time-today');
    check(updated.title===before.title && updated.afterBody && updated.last, '原位重画保留时间和正确布局');
    check(await page.eval(`return document.querySelectorAll('.msg[data-mid="time-today"] .msg-time').length===1;`), '原位重画不重复添加时间行');
    // 重新绘制完整历史，使用后端已有的稳定编号与时间，不启动真实会话生成。
    await post([{type:'clear',reconcile:true,keepDraft:true}, ...events.map(event=>({...event,replay:true})), {type:'syncPoint'}]);
    const replayed = await read('time-today');
    check(replayed.title===before.title && replayed.text===before.text && replayed.visible && replayed.afterBody, '历史对账保留原时刻，时间行常显且仍在正文之后');
    await post([
        ...[{type:'userMessage',text:'补入更早的历史。'}, {type:'assistantFull',text:'补入历史的第一段。',at:cases[0].at}, {type:'assistantFull',text:'补入历史的最后一段。',at:cases[0].at}]
            .map(event=>({type:'historyBatchEvent',event:{...event,replay:true}})),
        {type:'historyBatchEnd',hasMore:false},
    ]);
    check(await page.eval(`const find=text=>Array.from(document.querySelectorAll('.session-view:not(.off) .msg.assistant .md')).find(md=>md.dataset.raw===text)?.parentElement.querySelector('.msg-time'); const a=find('补入历史的第一段。'), b=find('补入历史的最后一段。'); return a?.hidden===true && b?.hidden===false;`), '补入更早历史后同轮仍只显示最后一段时间');
    await post([{type:'userMessage',id:'time-stream-user',text:'验证当场生成的时间行。'}, {type:'streamStart'}, {type:'assistantDelta',delta:'正在生成第一段。'}]);
    const streamTime = () => page.eval(`const message=Array.from(document.querySelectorAll('.session-view:not(.off) .msg.assistant')).at(-1); const time=message?.querySelector('.msg-time'); return time ? {title:time.title,visible:getComputedStyle(time).display!=='none',after:time.previousElementSibling?.classList.contains('md'),text:message.querySelector('.md').textContent} : null;`);
    const firstStream = await streamTime();
    await post([{type:'assistantDelta',delta:'\n\n第二段也生成完成。'}, {type:'streamEnd'}]);
    const lastStream = await streamTime();
    check(firstStream?.visible && lastStream?.visible && lastStream.after && firstStream.title===lastStream.title && lastStream.text.includes('第二段'), '流式增量与收尾保留常显时间，不挡正文、不重复生成');
    await post([
        {type:'userMessage',id:'time-mixed-user',text:'继续恢复当前文件。'},
        {type:'assistantFull',id:'time-mixed-start',text:'开始。本轮只收尾当前文件，先检查调用顺序。',at:now-60000},
        {type:'tool',toolName:'read',toolCallId:'time-read',args:{path:'example.cpp'}},
        {type:'toolResult',toolName:'read',toolCallId:'time-read',text:'已检查。'},
        {type:'assistantFull',id:'time-mixed-final',text:'当前文件已恢复，检查通过。其他文件保持暂停。',at:now},
        {type:'userMessage',id:'time-next-user',text:'继续检查下一份文件。'},
    ]);
    check(await page.eval(`const a=document.querySelector('.msg[data-mid="time-mixed-start"] .msg-time'), b=document.querySelector('.msg[data-mid="time-mixed-final"] .msg-time'); return getComputedStyle(a).display==='none' && getComputedStyle(b).display!=='none';`), '同轮多段回答和工具只在末段显示时间，不堆出多条分隔');
    check(await page.eval(`const t=document.querySelector('.msg[data-mid="time-mixed-final"] .msg-time').getBoundingClientRect(), u=document.querySelector('.msg[data-mid="time-next-user"]').getBoundingClientRect(); return u.top>=t.bottom+12;`), '时间行位于下一条提问前，有清楚留白');
    await page.eval(`document.querySelector('.msg[data-mid="time-mixed-final"]').scrollIntoView({block:'center'}); return true;`);
    await page.sleep(300); // 等新消息的进场动画结束再检查静态样式。
    await page.shot('msg-time.png');
};
