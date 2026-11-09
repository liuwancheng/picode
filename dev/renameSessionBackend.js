// @ts-nocheck
/** 后端改名回归：npm run compile && node dev/renameSessionBackend.js；不发模型消息。
 * --real-pi 另外用本机 pi 验原生 RPC 与标题桥的持久化（仍不调模型）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pichat-rename-'));
process.env.PICHAT_HOME = path.join(tmp, 'home');
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmp, 'sessions');
const out = path.resolve(__dirname, '../out/server');
const { ChatHost } = require(path.join(out, 'chatHost.js'));
const { PiClient } = require(path.join(out, 'piClient.js'));
const { scanSessionInfo } = require(path.join(out, 'sessionStore.js'));
const { titleBridgeSource } = require(path.join(out, 'titleBridgeSource.js'));
const cwd = path.join(tmp, 'work');
const otherCwd = path.join(tmp, 'other');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(otherCwd, { recursive: true });
const records = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
function fixture(dir, label, options = {}) {
    const folder = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, '--' + dir.replace(/^[/\\]/, '').replace(/[\\/:]/g, '-') + '--');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, label + '.jsonl');
    fs.writeFileSync(file, [
        { type: 'session', version: 3, id: randomUUID(), cwd: options.headerCwd || dir, timestamp: new Date().toISOString() },
        { type: 'message', id: 'user1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: '假历史', timestamp: Date.now() } },
        { type: 'session_info', id: 'info1', parentId: 'user1', name: '旧标题', timestamp: new Date().toISOString() },
    ].map(JSON.stringify).join('\n') + (options.noNewline ? '' : '\n'));
    return file;
}
const active = fixture(cwd, 'active');
const history = fixture(cwd, 'history', { noNewline: true });
const foreign = fixture(otherCwd, 'foreign');
const wrongHeader = fixture(cwd, 'wrong-header', { headerCwd: otherCwd });
const outside = path.join(tmp, 'outside.jsonl');
fs.copyFileSync(history, outside);

class TestHost extends ChatHost {
    ensureSpare() {} // 验历史改名绝不启动进程；活动会话只开一支假 pi。
    getConfig() {
        return { piPath: path.join(__dirname, process.platform === 'win32' ? 'fake-pi.cmd' : 'fake-pi.sh'),
            provider: '', model: '', extraArgs: [], trustProject: true };
    }
}
function waitFor(fn, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const result = fn();
            if (result) { resolve(result); return; }
            if (Date.now() - start > timeout) { reject(new Error('等待超时')); return; }
            setTimeout(tick, 10);
        };
        tick();
    });
}

async function hostChecks() {
    const host = new TestHost({ cwd, log() {} });
    const first = [], second = [];
    host.getBroadcaster().addChannel('first', (msg) => first.push(msg), () => {});
    host.getBroadcaster().addChannel('second', (msg) => second.push(msg), () => {});
    host.onServerStarted();
    let seq = 0;
    async function rename(file, dir, name, client = 'first', extra = {}) {
        const requestId = extra.requestId ?? ('rename-' + (++seq));
        host.processPageMessage({ type: 'renameSession', path: file, cwd: dir, name, requestId, ...extra }, client);
        const log = client === 'first' ? first : second;
        const response = await waitFor(() => log.find((m) => m.type === 'sessionRenamed' && m.requestId === requestId));
        assert.equal((client === 'first' ? second : first).some((m) => m.type === 'sessionRenamed' && m.requestId === requestId), false);
        return response;
    }
    try {
        // 没有任何活动进程，历史也能改名；无结尾换行不破坏 JSONL。
        const result = await rename(history, cwd, '  历史\n新标题  ');
        assert.equal(result.error, undefined);
        assert.equal(result.name, '历史 新标题');
        assert.equal(host.panels.size, 0);
        assert.equal((await scanSessionInfo(history)).title, result.name);
        const entries = records(history);
        assert.equal(entries.at(-2).parentId, 'info1');
        assert.equal(entries.at(-1).parentId, entries.at(-2).id);
        assert.equal(entries.at(-1).customType, 'pichat.title.manual');
        for (const log of [first, second]) {
            assert(log.some((m) => m.type === 'sessionTitleChanged' && m.file === history && m.name === result.name));
        }
        const before = fs.readFileSync(history, 'utf8');
        for (const name of [' ', 'x'.repeat(201), '非法\0字符', 42]) {
            assert((await rename(history, cwd, name)).error);
        }
        assert.equal(fs.readFileSync(history, 'utf8'), before);
        for (const [file, dir] of [[outside, cwd], [foreign, cwd], [wrongHeader, cwd], [history, otherCwd], ['relative.jsonl', cwd]]) {
            assert((await rename(file, dir, '不准写')).error);
        }
        assert.equal(fs.readFileSync(outside, 'utf8').includes('不准写'), false);
        assert.equal((await rename(history, cwd, '没有编号', 'first', { requestId: '' })).error !== undefined, true);

        const rt = host.newSessionInDir(cwd, { clientId: 'first' });
        assert(rt);
        await rt.loadSession(active);
        assert.equal(rt.currentSessionPath, active);
        host.setActiveSession(rt.id, 'second');
        const originalRequest = rt.request.bind(rt);
        const commands = [];
        rt.request = (cmd, timeout) => { commands.push(cmd.type); return originalRequest(cmd, timeout); };
        rt.streaming = true;
        rt.activity = 'tool';
        const originalClient = rt.client;
        // 原双击入口仍截到 40 字；菜单入口允许 200 字，二者共享同一个原生 RPC。
        assert.equal(await rt.renameSession('  ' + '双'.repeat(50) + '  '), true);
        assert.equal(rt.sessionTitle, '双'.repeat(40));
        assert.equal(await rt.renameSession('   '), false);
        assert.equal((await rename(active, cwd, '菜'.repeat(200), 'second')).error, undefined);
        assert.equal(rt.sessionTitle, '菜'.repeat(200));
        first.length = second.length = 0;
        const busy = await rename(active, cwd, '运行中改名', 'second');
        assert.equal(busy.error, undefined);
        assert(commands.includes('set_session_name'));
        assert(!commands.some((c) => ['prompt', 'steer', 'follow_up', 'abort', 'new_session', 'switch_session'].includes(c)));
        assert.equal(rt.client, originalClient);
        assert.equal(rt.streaming, true);
        assert.equal(rt.activity, 'tool');
        assert.equal(rt.currentSessionPath, active);
        assert.equal(rt.sessionTitle, busy.name);
        for (const log of [first, second]) {
            assert(log.some((m) => m.type === 'sessionList' && m.sessions.some((s) => s.file === active && s.title === busy.name)));
        }
        const focused = [host.getActive('first').id, host.getActive('second').id];
        const historyBeforeLoad = fs.readFileSync(history, 'utf8');
        rt.loading = true;
        rt.loadingSessionPath = history;
        assert.equal(await rt.renameSession('双击也不能改'), false);
        assert((await rename(history, cwd, '加载中不能从外面写')).error);
        assert((await rename(active, cwd, '加载中不能错改新文件')).error);
        assert.equal(fs.readFileSync(history, 'utf8'), historyBeforeLoad);
        rt.loading = false;
        rt.loadingSessionPath = undefined;
        assert.equal((await rename(history, cwd, '历史再次改名')).error, undefined);
        assert.deepEqual([host.getActive('first').id, host.getActive('second').id], focused);
        assert.equal(host.panels.size, 1);
        const concurrent = await Promise.all([
            rename(history, cwd, '并发一', 'first'), rename(history, cwd, '并发二', 'second'),
        ]);
        assert(concurrent.some((result) => !result.error));
        const latest = records(history);
        assert.equal(latest.at(-1).parentId, latest.at(-2).id);
        assert.equal((await scanSessionInfo(history)).title, latest.at(-2).name);
        await rt.sendCurrentModel();
        assert.equal(rt.sessionTitle, busy.name); // get_state 不把标题还原成假 pi 的默认标题。

        // RPC 失败不广播成功标题，也不会出现普通 systemError 或模型消息。
        const failureStart = first.length;
        rt.request = async (cmd) => cmd.type === 'set_session_name'
            ? { success: false, error: '模拟失败' } : originalRequest(cmd);
        const failure = await rename(active, cwd, '失败标题');
        assert.equal(failure.error, '模拟失败');
        assert(!first.slice(failureStart).some((m) => m.type === 'sessionTitleChanged' || m.type === 'systemError'));
        rt.request = originalRequest;
        assert.equal((await rename(active, otherCwd, '错工作区')).error !== undefined, true);
        assert.equal((await scanSessionInfo(active)).title, busy.name);
        rt.streaming = false;
        rt.activity = 'idle';
        // 关掉再打开，名字从 session_info 恢复。
        host.closeSession(rt.id);
        const reopened = host.newSessionInDir(cwd, { clientId: 'first' });
        await reopened.loadSession(active);
        await waitFor(() => reopened.sessionTitle === busy.name);
        console.log('✓ 后端：回执隔离 / 广播 / 历史持久 / 路径与名称校验 / 运行不中断 / RPC失败 / 重开');
    } finally { host.dispose(); }
}

function titleTestState(initial = [], delayedEvents = false) {
    const source = titleBridgeSource().replace(/import \{ randomUUID \} from "node:crypto";/, '').replace('export default function titleBridge', 'function titleBridge');
    const listeners = {};
    const entries = [...initial];
    const events = [];
    let title = entries.findLast((e) => e.type === 'session_info')?.name;
    let calls = 0;
    let complete = async () => ({ content: [{ type: 'text', text: '自动新标题' }] });
    const ctx = { model: {}, isIdle: () => true, sessionManager: { getBranch: () => entries, getEntries: () => entries },
        modelRegistry: { complete: (...args) => { calls++; return complete(...args); } } };
    const pi = {
        on: (name, handler) => { listeners[name] = handler; },
        getSessionName: () => title,
        setSessionName: (name) => {
            title = name;
            entries.push({ type: 'session_info', id: randomUUID(), name });
            const fire = () => listeners.session_info_changed({ name }, ctx);
            if (delayedEvents) { events.push(fire); } else { fire(); }
        },
        appendEntry: (customType, data) => entries.push({ type: 'custom', id: randomUUID(), customType, data }),
    };
    vm.runInNewContext(source + '\ntitleBridge(pi);', { pi, randomUUID, console });
    listeners.session_start({}, ctx);
    return { pi, ctx, entries, events, get calls() { return calls; }, get title() { return title; },
        settle: () => listeners.agent_settled({}, ctx), setComplete: (fn) => { complete = fn; } };
}
function turns(n) {
    return Array.from({ length: n }, () => [
        { type: 'message', message: { role: 'user', content: '假问题' } },
        { type: 'message', message: { role: 'assistant', content: '假回答' } },
    ]).flat();
}
async function bridgeChecks() {
    for (const delayed of [false, true]) {
        const s = titleTestState(turns(1), delayed);
        await s.settle();
        s.events.splice(0).forEach((f) => f());
        assert.equal(s.calls, 1);
        assert.equal(s.entries.some((e) => e.customType === 'pichat.title.manual'), false);
        s.entries.push(...turns(9));
        await s.settle();
        s.events.splice(0).forEach((f) => f());
        assert.equal(s.calls, 2); // 正常自动命名不会被自己的事件锁住。
        s.pi.setSessionName(s.title); // 同名手改也锁住。
        await s.settle();
        s.events.splice(0).forEach((f) => f());
        s.entries.push(...turns(60));
        await s.settle();
        assert.equal(s.calls, 2);
        assert(s.entries.some((e) => e.customType === 'pichat.title.manual'));
        const restart = titleTestState(s.entries);
        await restart.settle();
        assert.equal(restart.calls, 0);
    }
    const pending = titleTestState(turns(1), true);
    let resolve;
    pending.setComplete(() => new Promise((done) => { resolve = done; }));
    const run = pending.settle();
    pending.pi.setSessionName('手动标题');
    resolve({ content: [{ type: 'text', text: '不应覆盖' }] });
    await run;
    assert.equal(pending.title, '手动标题');
    pending.events.splice(0).forEach((f) => f());
    assert(pending.entries.some((e) => e.customType === 'pichat.title.manual'));

    // 生成中同名手改，且手动事件仍被别的扩展阻塞：靠 session_info 的 id 也能挡住。
    const same = titleTestState(turns(1), true);
    await same.settle();
    same.events.splice(0).forEach((f) => f());
    same.entries.push(...turns(9));
    same.setComplete(() => new Promise((done) => { resolve = done; }));
    const secondRun = same.settle();
    same.pi.setSessionName(same.title);
    resolve({ content: [{ type: 'text', text: '不应覆盖同名' }] });
    await secondRun;
    assert.equal(same.title, '自动新标题');
    same.events.splice(0).forEach((f) => f());
    assert(same.entries.some((e) => e.customType === 'pichat.title.manual'));
    console.log('✓ 标题桥：正常节点 / 同名手改 / 延迟事件 / 生成中改名 / 记号重启恢复');
}

async function realPiChecks() {
    const file = fixture(cwd, 'real-rpc');
    const extension = path.join(tmp, 'title.ts');
    fs.writeFileSync(extension, titleBridgeSource());
    const client = new PiClient({ piPath: 'pi', cwd, extraArgs: [
        '--approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--session', file, '-e', extension,
    ] });
    const events = [];
    client.on('event', (event) => events.push(event));
    client.on('error', (error) => console.error(error));
    client.on('stderr', (text) => process.stderr.write(text));
    try {
        client.start();
        assert(await client.waitReady());
        assert.equal((await client.request({ type: 'set_session_name', name: '旧标题' })).success, true);
        assert.equal((await client.request({ type: 'get_state' })).data.sessionName, '旧标题');
        await waitFor(() => records(file).some((e) => e.customType === 'pichat.title.manual'));
        assert.equal((await client.request({ type: 'set_session_name', name: '真 RPC 新标题' })).success, true);
        assert.equal((await scanSessionInfo(file)).title, '真 RPC 新标题');
        const entries = (await client.request({ type: 'get_entries' })).data.entries;
        assert(entries.some((e) => e.customType === 'pichat.title.manual'));
        assert.equal(entries.filter((e) => e.type === 'message').length, 1);
        assert.equal((await client.request({ type: 'switch_session', sessionPath: history })).success, true);
        assert.equal((await client.request({ type: 'get_state' })).data.sessionName, (await scanSessionInfo(history)).title);
        const loaded = (await client.request({ type: 'get_entries' })).data.entries;
        assert(loaded.some((e) => e.customType === 'pichat.title.manual'));
        assert.equal(loaded.filter((e) => e.type === 'message').length, 1);
        assert(!events.some((e) => e.type === 'agent_start' || e.type === 'message_start'));
        console.log('✓ 真 pi：原生 set_session_name / 同名事件 / 标题桥记号落盘 / 历史追加兼容 / 无模型消息');
    } finally { client.stop(); }
}

(async () => {
    await hostChecks();
    await bridgeChecks();
    if (process.argv.includes('--real-pi')) { await realPiChecks(); }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
