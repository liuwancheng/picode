// 真 pi RPC + 真后端 + 真浏览器：只用 steer/follow_up 排队，不调用模型。
// npm run compile && node dev/queueRpc.js
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.PICHAT_HOME = path.resolve(__dirname, '.scratch/queue-rpc-home');
process.env.PI_CODING_AGENT_SESSION_DIR = path.resolve(__dirname, '.scratch/queue-rpc-sessions');
const { createHarness } = require('./harness.js');
const { openPage } = require('./cdp.js');
(async () => {
    const harness = createHarness({ cwd: path.resolve(__dirname, '.scratch/queue-rpc-work'), piPath: process.env.QUEUE_TEST_PI || 'pi', port: 0 });
    let page, browser;
    const wait = async fn => {
        const start = Date.now();
        while (Date.now() - start < 15000) { if (await fn()) return; await page.sleep(100); }
        throw new Error('队列状态等待超时');
    };
    try {
        const url = await harness.start();
        const host = harness.host();
        const getConfig = host.getConfig.bind(host);
        // 只加载插件显式给的桥，避免用户自己的 session_start 扩展触发模型。
        host.getConfig = () => ({ ...getConfig(), extraArgs: ['--no-extensions', '--no-skills'] });
        host.ensureSpare = () => {};
        browser = await openPage({ url, width: 1000, height: 800, timeoutMs: 60000 });
        page = browser.page;
        await page.waitReady();
        const sid = await page.eval(`return document.querySelector('.session-view:not(.off) .session-pane').dataset.sessionId;`);
        const rt = harness.host().panels.get(sid);
        assert(rt?.client?.isRunning());
        assert((await rt.client.request({type:'steer', message:'真实 RPC 排队消息一'})).success);
        assert((await rt.client.request({type:'steer', message:'真实 RPC 排队消息二'})).success);
        assert((await rt.client.request({type:'follow_up', message:'真实 RPC 本轮后消息'})).success);
        await wait(() => page.eval(`return document.querySelectorAll('#queueBar .qb-action:not(:disabled)').length === 6;`));
        await page.click('#queueBar .qb-edit');
        await page.eval(`const i=document.querySelector('#queueBar .qb-edit-input'); i.value='真实 RPC 原位修改成功'; i.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
        await page.shot('queue-rpc-editing.png');
        await page.click('#queueBar .qb-save');
        await wait(() => page.eval(`return !document.querySelector('#queueBar .qb-edit-input') && document.querySelector('#queueBar .qb-preview')?.textContent === '真实 RPC 原位修改成功';`));
        assert.deepEqual(rt.queuedSteering, ['真实 RPC 原位修改成功', '真实 RPC 排队消息二']);
        assert.deepEqual(rt.queuedFollowUp, ['真实 RPC 本轮后消息']);
        await page.click('#queueBar .qb-block[data-kind="steering"][data-index="1"] .qb-cancel');
        await wait(() => rt.queuedSteering.length === 1);
        assert.deepEqual(rt.queuedSteering, ['真实 RPC 原位修改成功']);
        assert.deepEqual(rt.queuedFollowUp, ['真实 RPC 本轮后消息']);
        await page.shot('queue-rpc-saved.png');
        const state = await rt.client.request({type:'get_state'});
        assert.equal(state.data.isStreaming, false);
        assert.equal(state.data.messageCount, 0, '内部队列命令不能成为模型输入或会话消息');
        console.log('通过：真 pi RPC 在位修改/单条删除、真实网页队列更新、未启动模型。');
    } finally {
        if (browser) await browser.close();
        await harness.stop();
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
