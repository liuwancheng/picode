/** 真 pi SDK + 后端路由回归；人工填 native 队列，不启动任何模型。
 * npm run compile && node dev/queueBridgeBackend.mjs [pi-coding-agent 包的绝对目录]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { QUEUE_BRIDGE_SOURCE, QUEUE_REMOVE_COMMAND, QUEUE_RESULT_PREFIX, decodeQueueResult } = require('../out/server/queueBridgeSource.js');
const { SessionRuntime, commandMenuItems } = require('../out/server/sessionRuntime.js');
const { ChatHost } = require('../out/server/chatHost.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pichat-queue-'));
process.env.PICHAT_HOME = path.join(tmp, 'home');
const piRoot = process.argv[2] || 'C:/Users/liuwancheng/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent';
const sdk = await import(pathToFileURL(path.join(piRoot, 'dist/index.js')).href);
const bridge = path.join(tmp, 'queue-bridge.ts');
fs.writeFileSync(bridge, QUEUE_BRIDGE_SOURCE);
class TestHost extends ChatHost { ensureSpare() {} }
const host = new TestHost({ cwd: tmp, log() {} });
const first = [], second = [];
host.getBroadcaster().addChannel('first', msg => first.push(msg), () => {});
host.getBroadcaster().addChannel('second', msg => second.push(msg), () => {});
host.onServerStarted();
const sessions = [];
const commands = [];
let sequence = 0;

async function makeSession(id) {
    const cwd = path.join(tmp, id);
    const agentDir = path.join(tmp, 'agent-' + id);
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        additionalExtensionPaths: [bridge] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
        noTools: true, sessionManager: sdk.SessionManager.inMemory(cwd) });
    sessions.push(session);
    session.agent.streamFunction = () => { throw new Error('测试不允许调用模型'); };
    session.clearQueue = () => { throw new Error('禁止 clearQueue'); };
    session._runInputHandlers = () => { throw new Error('禁止重新输入处理'); };
    session._expandSkillCommand = () => { throw new Error('禁止重新展开技能'); };
    const rt = new SessionRuntime(id, { adjective: '测试', noun: id }, host);
    host.panels.set(id, rt);
    const client = {
        isRunning: () => true,
        stop() {},
        request: async cmd => {
            commands.push(cmd.type);
            if (cmd.type === 'get_commands') {
                return { success: true, data: { commands: session.extensionRunner.getRegisteredCommands()
                    .map(command => ({ name: command.invocationName, source: 'extension' })) } };
            }
            if (cmd.type === 'prompt') {
                assert(cmd.message.startsWith('/' + QUEUE_REMOVE_COMMAND + ' '));
                assert(!('images' in cmd) && !('streamingBehavior' in cmd));
                try {
                    let disposition;
                    await session.prompt(cmd.message, { source: 'rpc', preflightResult: result => { disposition = result; } });
                    return { success: true, data: { disposition } };
                } catch (error) { return { success: false, error: error.message }; }
            }
            throw new Error('不应发送 ' + cmd.type);
        },
    };
    rt.client = client;
    rt.piReady = true;
    rt.streaming = true;
    session.subscribe(event => rt.onPiEvent(event));
    await session.bindExtensions({ mode: 'rpc', uiContext: {
        notify: message => rt.onPiUiRequest({ method: 'notify', message }),
    }, onError: error => rt.onPiEvent({ type: 'extension_error', ...error }) });
    // busy 下同样先处理扩展命令；不启动 agent loop。
    session._isAgentRunActive = true;
    return { session, rt, client };
}
function user(text, images = []) {
    return { role: 'user', content: [{ type: 'text', text }, ...images.map(image => ({ type: 'image', ...image }))], timestamp: Date.now() };
}
function setQueue(item, steering, followUp, nativeSteering, nativeFollowUp) {
    item.session._steeringMessages = steering.slice();
    item.session._followUpMessages = followUp.slice();
    item.session.agent.steeringQueue.messages = nativeSteering.slice();
    item.session.agent.followUpQueue.messages = nativeFollowUp.slice();
    item.session._emitQueueUpdate();
}
async function action(item, fields = {}, page = 'first') {
    const requestId = fields.requestId || 'queue-' + (++sequence);
    const msg = { type: 'queueAction', sessionId: item.rt.id, requestId, act: 'cancel', kind: 'steering',
        index: 0, text: item.rt.queuedSteering[0] ?? '', revision: item.rt.queueRevision, ...fields };
    const records = page === 'first' ? first : second;
    const other = page === 'first' ? second : first;
    const initial = records.length;
    const otherInitial = other.length;
    host.processPageMessage(msg, page);
    for (let attempts = 0; attempts < 100; attempts++) {
        const result = records.slice(initial).find(msg => msg.type === 'queueActionResult' && msg.requestId === requestId);
        if (result) {
            assert(!other.slice(otherInitial).some(msg => msg.type === 'queueActionResult' && msg.requestId === requestId));
            return result;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('未收到 queueActionResult');
}
try {
    const a = await makeSession('a');
    const b = await makeSession('b');
    // 真 _queueSteer 在推事件之后才写 native queue，结构能力检查不能误关操作。
    const nativeImage = { type: 'image', data: 'native', mimeType: 'image/png' };
    await b.session._queueSteer('真入队', [nativeImage]);
    assert(b.rt.queueEditable);
    const native = b.session.agent.steeringQueue.messages[0];
    const nativeTime = native.timestamp;
    const nativeEdit = await action(b, { text: '真入队', act: 'edit', replacement: '真修改' });
    assert.equal(nativeEdit.success, true);
    assert.equal(nativeEdit.text, '真修改');
    assert(!('images' in nativeEdit));
    assert.equal(b.session.agent.steeringQueue.messages[0], native);
    assert.equal(native.content[1], nativeImage);
    assert.equal(native.timestamp, nativeTime);
    assert.deepEqual(b.session._steeringMessages, ['真修改']);
    assert.deepEqual(b.rt.queuedSteering, ['真修改']);
    await b.session._queueFollowUp('真跟进');
    assert.equal((await action(b, { kind: 'followUp', text: '真跟进', act: 'edit', replacement: '修改跟进' })).success, true);
    assert.equal((await action(b, { kind: 'followUp', text: '修改跟进' })).success, true);
    assert.equal((await action(b, { text: '真修改' })).success, true);
    // 以下操作不能调用任何入队方法，也不能清队列、输入处理、技能展开或模型。
    for (const item of [a, b]) {
        item.session._queueSteer = item.session._queueFollowUp = item.session.agent.steer = item.session.agent.followUp =
            () => { throw new Error('禁止重排或重发'); };
    }
    const images = [{ data: 'a'.repeat(400000), mimeType: 'image/png' }];
    const one = user('重复', [{ data: 'first', mimeType: 'image/png' }]);
    const two = user('重复', images);
    const tail = user('尾条');
    const custom = { role: 'custom', customType: 'test', content: '不要动', display: false, timestamp: Date.now() };
    const follow = user('跟进', [{ data: 'follow', mimeType: 'image/jpeg' }]);
    const originalOne = structuredClone(one), originalTail = structuredClone(tail), originalCustom = structuredClone(custom);
    const twoContent = two.content, twoBlock = two.content[0], twoImage = two.content[1], twoTime = two.timestamp;
    const followContent = follow.content, followImage = follow.content[1], followTime = follow.timestamp;
    setQueue(a, ['重复', '重复', '尾条'], ['跟进'], [custom, one, custom, two, tail], [custom, follow]);
    setQueue(b, ['重复'], [], [user('重复')], []);
    const steeringTexts = a.session._steeringMessages, followTexts = a.session._followUpMessages;
    const steeringMessages = a.session.agent.steeringQueue.messages, followMessages = a.session.agent.followUpQueue.messages;
    const bRevision = b.rt.queueRevision;
    assert(a.rt.queueEditable);
    assert.notEqual(a.session.sessionManager, b.session.sessionManager);
    const revision = a.rt.queueRevision;
    const replacement = '  新原文\n保留空白  ';
    const result = await action(a, { act: 'edit', index: 1, text: '重复', replacement });
    assert.equal(result.success, true);
    assert.equal(result.text, replacement);
    assert(!('images' in result)); // 大图留在 native 原对象，不经过回执。
    assert.deepEqual(a.session._steeringMessages, ['重复', replacement, '尾条']);
    assert.deepEqual(a.rt.queuedSteering, ['重复', replacement, '尾条']);
    assert.equal(a.session._steeringMessages, steeringTexts);
    assert.equal(a.session.agent.steeringQueue.messages, steeringMessages);
    assert.equal(steeringMessages.length, 5);
    [custom, one, custom, two, tail].forEach((message, index) => assert.equal(steeringMessages[index], message));
    assert.equal(two.content, twoContent);
    assert.equal(two.content[0], twoBlock);
    assert.equal(two.content[1], twoImage);
    assert.equal(two.timestamp, twoTime);
    assert.deepEqual(twoImage, { type: 'image', ...images[0] });
    assert.deepEqual(one, originalOne);
    assert.deepEqual(tail, originalTail);
    assert.deepEqual(custom, originalCustom);
    assert(a.rt.queueRevision > revision);
    assert.equal(b.rt.queueRevision, bRevision);
    assert.deepEqual(b.session._steeringMessages, ['重复']);
    assert(first.some(msg => msg.type === 'queueUpdate' && msg.sessionId === 'a' && msg.revision === a.rt.queueRevision && msg.editable));
    assert(second.some(msg => msg.type === 'queueUpdate' && msg.sessionId === 'a' && msg.revision === a.rt.queueRevision && msg.editable));
    // 编辑期间任何 queue_update 或原文改变都会拒绝陈旧保存，原消息仍排队。
    assert.equal((await action(a, { act: 'edit', index: 1, text: '重复', replacement: '陈旧保存', revision })).success, false);
    assert.equal((await action(a, { act: 'edit', index: 1, text: '重复', replacement: '陈旧原文' })).success, false);
    const beforeInvalid = commands.length;
    for (const invalid of [undefined, '', ' \n\t ', 42, null]) {
        assert.equal((await action(a, { act: 'edit', replacement: invalid })).success, false);
    }
    assert.equal(commands.length, beforeInvalid); // 无 replacement 的旧取回请求在后端就拒绝。
    assert.equal((await action(a, { index: -1 })).success, false);
    assert.equal((await action(a, { kind: 'unknown' })).success, false);
    assert.equal((await action(a, { sessionId: undefined, tabId: 'a' })).success, false);
    assert.equal((await action(a, { sessionId: 'closed' })).success, false);
    const followReplacement = '/skill:不展开 原文';
    const followResult = await action(a, { kind: 'followUp', text: '跟进', act: 'edit', replacement: followReplacement }, 'second');
    assert.equal(followResult.success, true);
    assert.equal(followResult.text, followReplacement);
    assert(!('images' in followResult));
    assert.equal(a.session._followUpMessages, followTexts);
    assert.deepEqual(followTexts, [followReplacement]);
    assert.deepEqual(a.rt.queuedFollowUp, [followReplacement]);
    assert.equal(a.session.agent.followUpQueue.messages, followMessages);
    assert.equal(followMessages.length, 2);
    assert.equal(followMessages[0], custom);
    assert.equal(followMessages[1], follow);
    assert.equal(follow.content, followContent);
    assert.equal(follow.content[1], followImage);
    assert.equal(follow.timestamp, followTime);
    assert.equal(follow.content[0].text, followReplacement);
    const followCancel = await action(a, { kind: 'followUp', text: followReplacement });
    assert.equal(followCancel.success, true);
    assert(!('text' in followCancel) && !('images' in followCancel));
    assert.deepEqual(followMessages, [custom]);
    assert.deepEqual(followTexts, []);
    // 两个页面同时保存同一 revision：只成功一次，不会删任何消息。
    const competingRevision = a.rt.queueRevision;
    const results = await Promise.all([action(a, { act: 'edit', replacement: '竞态修改', revision: competingRevision, requestId: 'race-first' }, 'first'),
        action(a, { act: 'edit', replacement: '竞态修改', revision: competingRevision, requestId: 'race-second' }, 'second')]);
    assert.equal(results.filter(result => result.success).length, 1);
    assert.deepEqual(steeringTexts, ['竞态修改', replacement, '尾条']);
    assert.equal(steeringMessages.length, 5);
    const cancel = await action(a, { index: 1, text: replacement });
    assert.equal(cancel.success, true);
    assert(!('text' in cancel) && !('images' in cancel));
    assert.deepEqual(steeringTexts, ['竞态修改', '尾条']);
    assert.deepEqual(steeringMessages, [custom, one, custom, tail]);
    // native 已取走但 AgentSession 尚未收到 message_start：不误改另一条。
    a.session.agent.steeringQueue.messages = [custom, tail];
    const racing = await action(a, { text: '竞态修改', act: 'edit', replacement: '不能保存' });
    assert.equal(racing.success, false);
    assert.match(racing.error, /投递|不匹配/);
    assert.deepEqual(steeringTexts, ['竞态修改', '尾条']);
    assert.equal(tail.content[0].text, '尾条');
    // 任一 native 双队列身份不匹配都关闭 mutation，即使目标 steering 自己正常。
    setQueue(a, ['尾条'], ['跟进'], [custom, tail], []);
    assert.equal((await action(a, { act: 'edit', replacement: '不能保存' })).success, false);
    assert.equal(tail.content[0].text, '尾条');
    // 结构变化关闭按钮，仍然展示文本队列。
    a.session.agent.steeringQueue.messages = undefined;
    a.session._emitQueueUpdate();
    assert.equal(a.rt.queueEditable, false);
    assert.deepEqual(a.rt.queuedSteering, ['尾条']);
    assert.equal((await action(a, { text: '尾条', act: 'edit', replacement: '不能保存' })).success, false);
    // 两个页面同时取消同一 revision：原子删单条，custom 与尾条仍在原顺序。
    const duplicate = user('重复');
    setQueue(b, ['重复', '尾条'], [], [custom, duplicate, custom, tail], []);
    const cancelRevision = b.rt.queueRevision;
    const cancels = await Promise.all([
        action(b, { revision: cancelRevision, requestId: 'cancel-first' }, 'first'),
        action(b, { revision: cancelRevision, requestId: 'cancel-second' }, 'second'),
    ]);
    assert.equal(cancels.filter(result => result.success).length, 1);
    assert.deepEqual(b.session._steeringMessages, ['尾条']);
    assert.deepEqual(b.session.agent.steeringQueue.messages, [custom, custom, tail]);
    // native message/content/任一 block 冻结，以及 text/summary 槽位不可写：失败且没有半更新。
    const protections = [
        message => Object.freeze(message),
        message => Object.freeze(message.content),
        message => Object.freeze(message.content[0]),
        message => Object.freeze(message.content[1]),
        message => Object.defineProperty(message.content[0], 'text', { writable: false }),
        () => Object.freeze(b.session._steeringMessages),
        () => Object.freeze(b.session.agent.steeringQueue.messages),
        () => Object.defineProperty(b.session._steeringMessages, '0', { writable: false }),
        message => Object.defineProperty(message.content[0], 'text', { get: () => '保护原文', set() { throw new Error('不能调用 setter'); } }),
    ];
    for (const protect of protections) {
        const protectedMessage = user('保护原文', [{ data: 'protected', mimeType: 'image/png' }]);
        setQueue(b, ['保护原文'], [], [custom, protectedMessage, tail], []);
        const nativeQueue = b.session.agent.steeringQueue.messages;
        const summary = b.session._steeringMessages;
        const snapshot = structuredClone(nativeQueue);
        const beforeRevision = b.rt.queueRevision;
        protect(protectedMessage);
        const rejected = await action(b, { act: 'edit', replacement: '不能写' });
        assert.equal(rejected.success, false);
        assert.equal(b.session.agent.steeringQueue.messages, nativeQueue);
        assert.equal(b.session._steeringMessages, summary);
        assert.deepEqual(nativeQueue, snapshot);
        assert.deepEqual(summary, ['保护原文']);
        assert.deepEqual(b.rt.queuedSteering, ['保护原文']);
        assert.equal(b.rt.queueRevision, beforeRevision);
    }
    // cancel 的两个 splice 也必须预核对非枚举只读槽位，不能先删 native 再发现 summary 不可删。
    for (const native of [false, true]) {
        const protectedMessage = user('不可删');
        setQueue(b, ['不可删', '尾条'], [], [protectedMessage, tail], []);
        const summary = b.session._steeringMessages, messages = b.session.agent.steeringQueue.messages;
        Object.defineProperty(native ? messages : summary, '0', { enumerable: false, writable: false });
        assert.equal((await action(b)).success, false);
        assert.deepEqual(summary, ['不可删', '尾条']);
        assert.deepEqual(messages, [protectedMessage, tail]);
    }
    // 未知 user 内容和共享首文本块拒绝，custom 与已知图片不动。
    const unknown = user('未知');
    unknown.content.push({ type: 'other', data: '未知块' });
    setQueue(b, ['未知'], [], [unknown], []);
    assert.equal((await action(b, { act: 'edit', replacement: '不能写' })).success, false);
    const shared = user('共享');
    setQueue(b, ['共享'], ['共享'], [shared], [{ ...shared }]);
    assert.equal((await action(b, { act: 'edit', replacement: '不能连带改' })).success, false);
    assert.equal(shared.content[0].text, '共享');
    assert.deepEqual(b.session._steeringMessages, ['共享']);
    assert.deepEqual(b.session._followUpMessages, ['共享']);
    setQueue(b, ['闲时'], [], [user('闲时')], []);
    b.session._isAgentRunActive = false;
    assert.equal((await action(b, { act: 'edit', replacement: '闲时修改' })).success, true);
    assert.deepEqual(b.session._steeringMessages, ['闲时修改']);
    b.session._isAgentRunActive = true;
    setQueue(b, ['重复'], [], [user('重复')], []);
    // ctx.manager 身份、原生会话 id、revision 三道门；直接绕后端也一样拒绝。
    const directRequest = { requestId: 'direct', act: 'cancel', kind: 'steering', index: 0,
        text: '重复', revision: b.rt.queueRevision, nativeSessionId: a.session.sessionId };
    let direct;
    const handler = b.session.extensionRunner.getCommand(QUEUE_REMOVE_COMMAND).handler;
    const ctx = b.session.extensionRunner.createCommandContext();
    assert.equal(ctx.sessionManager, b.session.sessionManager);
    const originalNotify = ctx.ui.notify;
    ctx.ui.notify = message => { direct = decodeQueueResult(message); };
    handler(Buffer.from(JSON.stringify(directRequest)).toString('base64'), ctx);
    ctx.ui.notify = originalNotify;
    assert.equal(direct.success, false);
    assert.match(direct.error, /会话/);
    directRequest.nativeSessionId = b.session.sessionId;
    directRequest.revision--;
    ctx.ui.notify = message => { direct = decodeQueueResult(message); };
    handler(Buffer.from(JSON.stringify(directRequest)).toString('base64'), ctx);
    ctx.ui.notify = originalNotify;
    assert.equal(direct.success, false);
    assert.match(direct.error, /变化/);
    assert.deepEqual(b.session._steeringMessages, ['重复']);
    // 直接绕过后端的 edit 也必须有非空 replacement；原文与 revision 仍核对。
    directRequest.act = 'edit';
    directRequest.revision = b.rt.queueRevision;
    for (const replacement of [undefined, '', ' \n ', 42]) {
        ctx.ui.notify = message => { direct = decodeQueueResult(message); };
        handler(Buffer.from(JSON.stringify({ ...directRequest, replacement })).toString('base64'), ctx);
        ctx.ui.notify = originalNotify;
        assert.equal(direct.success, false);
        assert.match(direct.error, /参数/);
        assert.deepEqual(b.session._steeringMessages, ['重复']);
    }
    // RPC handled 不能掩盖扩展抛错；结果必须失败且保留错误原话，队列不动。
    const originalRequest = b.client.request;
    b.client.request = async command => {
        if (command.type !== 'prompt') { return originalRequest(command); }
        b.rt.onPiEvent({ type: 'extension_error', extensionPath: 'command:' + QUEUE_REMOVE_COMMAND, error: '测试扩展异常' });
        return { success: true, data: { disposition: 'handled' } };
    };
    const extensionFailure = await action(b, { text: '重复' });
    assert.equal(extensionFailure.success, false);
    assert.equal(extensionFailure.error, '测试扩展异常');
    assert.deepEqual(b.session._steeringMessages, ['重复']);
    b.client.request = originalRequest;
    // /reload 拿掉内部命令：prototype guard 拒绝，不能成为普通用户消息。
    const runner = b.session.extensionRunner;
    const originalGetCommand = runner.getCommand;
    runner.getCommand = () => undefined;
    await assert.rejects(b.session.prompt('/' + QUEUE_REMOVE_COMMAND + ' e30='), /桥已失效/);
    runner.getCommand = () => ({ handler() { throw new Error('不应执行替代 handler'); } });
    await assert.rejects(b.session.prompt('/' + QUEUE_REMOVE_COMMAND + ' e30='), /桥已失效/);
    runner.getCommand = originalGetCommand;
    assert.deepEqual(commandMenuItems([{ name: QUEUE_REMOVE_COMMAND, source: 'extension' },
        { name: QUEUE_REMOVE_COMMAND + ':1', source: 'extension' }])
        .filter(command => command.name.startsWith(QUEUE_REMOVE_COMMAND)), []);
    assert(!first.concat(second).some(msg => msg.type === 'system' && String(msg.text).startsWith(QUEUE_RESULT_PREFIX)));
    assert(commands.every(command => ['get_commands', 'prompt'].includes(command)));
    assert(sessions.every(session => session.messages.length === 0));
    console.log('通过：真 pi SDK 双队列原位修改、重复原文指定 index、大图/custom/对象/顺序/时间戳保留、followUp 修改、cancel 删单条、陈旧/投递竞态拒绝、冻结/不可写无半更新、未知结构拒绝、跨会话与双页面定向结果、无模型/clear/重排/重新输入、reload 防模型回落。');
} finally {
    for (const session of sessions) { session._isAgentRunActive = false; session.dispose(); }
    host.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
}
