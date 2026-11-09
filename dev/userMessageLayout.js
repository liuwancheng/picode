// @ts-nocheck
/**
 * userMessageLayout —— 真界面、假消息，验提问的靠右缩宽与轮间留白；不向 AI 发消息。
 *
 * npm run web:shot -- --fake-pi --width 420 --height 900 --script dev/userMessageLayout.js
 * npm run web:shot -- --fake-pi --width 1000 --height 900 --theme dark --script dev/userMessageLayout.js
 * 截图恢复成自然的多轮问答，名字带窗口宽度与主题。失败也先截图再报错。
 */
module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const paneSelector = '.session-view:not(.off) .session-pane';
    const sid = await page.eval(`return document.querySelector(${JSON.stringify(paneSelector)}).dataset.sessionId;`);
    const post = async (messages) => {
        await page.eval(`for (const m of ${JSON.stringify(messages)}) {
            window.postMessage({ ...m, sessionId: ${JSON.stringify(sid)} }, "*");
        } return true;`);
        await page.sleep(400); // 等 postMessage、布局与入场动画结束，几何测量不吃 transform。
    };
    const check = (ok, what) => { if (!ok) { problems.push(what); } };
    const natural = [
        { type: 'userMessage', text: '这次审核的结论是什么？' },
        { type: 'tool', toolName: 'read', args: { path: '审核记录.md' } },
        { type: 'assistantFull', text: '审核已完成，结论是**有条件通过**。主体内容没有发现阻断问题，但还有两项需要补齐：\n\n- 更新权限说明，明确哪些角色可以导出数据。\n- 补充失败后的重试记录，确保问题能够追溯。' },
        { type: 'userMessage', text: '关于这次审核结论，我想再确认一下：你说的“有条件通过”是否意味着我们可以先发布，再补齐权限说明和重试记录？请把必须在发布前完成的事项、可以后续补充的材料，以及每一项对应的验收依据分别说明，避免团队把建议项误当成阻断项。如果还有需要负责人确认的风险，也请一起列出来。' },
        { type: 'tool', toolName: 'read', args: { path: '发布检查清单.md' } },
        { type: 'assistantFull', text: '不能直接理解为“先发布再补”。**权限边界必须在发布前确认**，负责人签字后才能放行；重试记录可以随后补充，但应先验证失败不会造成重复操作。\n\n建议先完成权限检查和失败场景验证，再把证据链接补到发布清单里。' },
        { type: 'userMessage', text: '继续' },
        { type: 'assistantFull', text: '下一步先核对权限检查的结果，再确认重试验证是否已有可复现的记录。' },
    ];
    await post([{ type: 'clear' }, ...natural]);

    // 每条的坐标都相对于同一个窗格；即使被滚出屏幕，差值仍能用于量间距。
    const layout = await page.eval(`
        const pane = document.querySelector(${JSON.stringify(paneSelector)});
        const ps = getComputedStyle(pane), pr = pane.getBoundingClientRect();
        const left = pr.left + parseFloat(ps.paddingLeft);
        const width = pane.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
        const users = [...pane.querySelectorAll('.msg.user')].map(el => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            const range = document.createRange(); range.selectNodeContents(el.firstElementChild);
            const text = range.getBoundingClientRect();
            // Canvas 把 color(srgb …) / rgba 等计算颜色统一成通道值。
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1);
            return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom,
                rightInset: left + width - r.right, textLeft: text.left - r.left,
                align: s.textAlign, box: s.boxSizing, radius: parseFloat(s.borderTopLeftRadius),
                lineRatio: parseFloat(s.lineHeight) / parseFloat(s.fontSize),
                marginTop: parseFloat(s.marginTop), bg: [...ctx.getImageData(0, 0, 1, 1).data] };
        });
        const assistants = [...pane.querySelectorAll('.msg.assistant')].map(el => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return { top: r.top, bottom: r.bottom, padding: s.paddingLeft, bg: s.backgroundColor };
        });
        const tools = [...pane.querySelectorAll('.tool-row')].map(el => {
            const r = el.getBoundingClientRect(), tag = el.querySelector('.tool').getBoundingClientRect();
            return { top: r.top, left: tag.left, parent: el.parentElement === pane,
                insideUser: !!el.closest('.user'), display: getComputedStyle(el).display };
        });
        const readingMax = parseFloat(ps.getPropertyValue('--pichat-content-max'));
        return { width, left, users, assistants, tools,
            rightInset: Math.max(14, (width - readingMax) / 2), max: Math.min(width - 28, readingMax) * .85 };
    `);
    console.log('自然问答布局：' + JSON.stringify(layout));
    check(layout.users.length === 3 && layout.assistants.length === 3 && layout.tools.length === 2, '自然样例消息数量不对');
    if (layout.users.length === 3 && layout.assistants.length === 3 && layout.tools.length === 2) {
        const [short, long, again] = layout.users;
        check(Math.abs(short.rightInset - layout.rightInset) <= 1 && Math.abs(again.rightInset - layout.rightInset) <= 1, '短提问没有靠在正文列右边');
        check(short.width < layout.max * .75 && again.width < short.width, '短提问没有随内容缩宽（“继续”应更窄）');
        check(Math.abs(short.marginTop - 12) <= 1, '首条提问的 margin-top 不是 12px');
        check(Math.abs(long.width - layout.max) <= 1 && Math.abs(long.rightInset - layout.rightInset) <= 1, '长提问没有保持正文 85% 最大宽度与右对齐');
        check(['left', 'start'].includes(long.align) && Math.abs(long.textLeft - 16) <= 1, '长提问的块内文字没有靠左');
        check(long.top - layout.assistants[0].bottom >= 31.5 && again.top - layout.assistants[1].bottom >= 31.5, '回答到新提问留白不足 32px');
        check(layout.tools[0].top - short.bottom >= 19.5 && layout.tools[1].top - long.bottom >= 19.5, '提问到工具标签留白不足 20px');
        for (const tool of layout.tools) {
            check(tool.parent && !tool.insideUser && tool.left < long.left && tool.display === 'flex', '工具标签没有独立留在左侧');
        }
        for (const user of layout.users) {
            check(user.box === 'border-box' && user.radius === 16 && Math.abs(user.lineRatio - 1.6) < .01, '提问的 border-box / 16px 圆角 / 1.6 行高不对');
            check(user.bg[3] > 0 && Math.max(...user.bg.slice(0, 3)) - Math.min(...user.bg.slice(0, 3)) <= 24, '提问背景不是浅中性色（请结合截图确认主题下明度）');
        }
        check(layout.assistants.every(a => a.padding === '14px' && a.bg === 'rgba(0, 0, 0, 0)'), '回答的内边距或透明背景变了');
    }

    const unbroken = 'AuditReference'.repeat(240); // 一行、无空格；不足 8000 字，不走长文本折叠。
    const multiline = Array.from({ length: 16 }, (_, i) => `第 ${i + 1} 项：确认审核证据与负责人签字。${i === 8 ? unbroken : ''}`).join('\n');
    await post([
        { type: 'clear' },
        { type: 'userMessage', text: '继续' },
        { type: 'userMessage', text: '再确认一下' },
        { type: 'userMessage', text: unbroken },
        { type: 'userMessage', text: multiline },
    ]);
    // 折叠、展开、收起都量横向范围，包括长文本内部的 pre，避免 overflow:auto 掩盖问题。
    for (const stage of ['折叠', '展开', '收起']) {
        if (stage !== '折叠') {
            await page.click(paneSelector + ' .msg.user .lm-toggle');
            await page.sleep(100);
        }
        const edge = await page.eval(`
            const pane = document.querySelector(${JSON.stringify(paneSelector)});
            const users = [...pane.querySelectorAll('.msg.user')];
            const first = users[0].getBoundingClientRect(), second = users[1].getBoundingClientRect();
            const last = users[3], pre = last.querySelector('pre'), toggle = last.querySelector('.lm-toggle');
            return { count: users.length, gap: second.top - first.bottom,
                margin: parseFloat(getComputedStyle(users[1]).marginTop),
                overflow: [document.documentElement, pane, ...users, ...last.querySelectorAll('*')]
                    .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName),
                expanded: pre ? pre.classList.contains('full') : null,
                text: pre ? pre.textContent : '', toggle: toggle ? toggle.textContent : '' };
        `);
        console.log(stage + '边界布局：' + JSON.stringify({ ...edge, text: edge.text.slice(0, 80) }));
        check(edge.count === 4, stage + '：边界消息数量不对');
        check(edge.gap >= 11.5 && edge.gap <= 21 && edge.margin === 12, stage + '：连续提问间距过大或没有 12px 顶部间距');
        check(edge.overflow.length === 0, stage + '：存在横向溢出 ' + edge.overflow.join(', '));
        check(edge.expanded === (stage === '展开'), stage + '：长文本展开状态不对');
        check(stage === '展开' ? edge.text === multiline && edge.toggle.startsWith('收起')
            : edge.text.endsWith('…') && edge.toggle.startsWith('展开'), stage + '：长文本正文或切换按钮不对');
    }

    // 边界数据不进入最终图：恢复自然问答，末尾保留长提问、回答与“继续”。
    await post([{ type: 'clear' }, ...natural]);
    const label = await page.eval(`
        const pane = document.querySelector(${JSON.stringify(paneSelector)});
        pane.scrollTop = pane.scrollHeight;
        const bg = getComputedStyle(document.body).backgroundColor;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, 1, 1);
        const c = ctx.getImageData(0, 0, 1, 1).data;
        return innerWidth + '-' + (c[0] * .2126 + c[1] * .7152 + c[2] * .0722 < 128 ? 'dark' : 'light');
    `);
    await page.sleep(150);
    const shot = await page.shot('user-message-layout-' + label + '.png');
    console.log('自然问答截图：' + shot);
    if (problems.length) { throw new Error('提问布局回归失败：\n  - ' + problems.join('\n  - ')); }
    console.log('提问布局全部通过。');
};
