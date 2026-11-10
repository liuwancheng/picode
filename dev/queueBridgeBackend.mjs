/** 真 pi SDK + 后端路由回归；busy prompt 真入队与人工 native 队列均不启动模型。
 * npm run compile && node dev/queueBridgeBackend.mjs [pi-coding-agent 包的绝对目录]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { QUEUE_BRIDGE_SOURCE, QUEUE_REMOVE_COMMAND, QUEUE_RESULT_PREFIX, QUEUE_PROMPT_PREFIX, encodeQueuePrompt, decodeQueueResult } = require('../out/server/queueBridgeSource.js');
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
    const pendingSends = [];
    const queueEvents = [];
    const client = {
        isRunning: () => true,
        send(cmd) { pendingSends.push(this.request(cmd)); },
        stop() {},
        request: async cmd => {
            commands.push(cmd.type);
            if (cmd.type === 'get_commands') {
                return { success: true, data: { commands: session.extensionRunner.getRegisteredCommands()
                    .map(command => ({ name: command.invocationName, source: 'extension' })) } };
            }
            if (cmd.type === 'prompt') {
                if (cmd.message.startsWith('/' + QUEUE_REMOVE_COMMAND + ' ')) {
                    assert(!('images' in cmd) && !('streamingBehavior' in cmd));
                } else {
                    assert(['steer', 'followUp'].includes(cmd.streamingBehavior));
                }
                try {
                    let disposition;
                    await session.prompt(cmd.message, { source: 'rpc', streamingBehavior: cmd.streamingBehavior,
                        images: cmd.images, preflightResult: result => { disposition = result; } });
                    return { success: true, data: { disposition } };
                } catch (error) { return { success: false, error: error.message }; }
            }
            throw new Error('不应发送 ' + cmd.type);
        },
    };
    rt.client = client;
    rt.piReady = true;
    rt.streaming = true;
    session.subscribe(event => {
        if (event.type === 'queue_update') { queueEvents.push(event); }
        rt.onPiEvent(event);
    });
    await session.bindExtensions({ mode: 'rpc', uiContext: {
        notify: message => rt.onPiUiRequest({ method: 'notify', message }),
    }, onError: error => rt.onPiEvent({ type: 'extension_error', ...error }) });
    // busy 下同样先处理扩展命令；不启动 agent loop。
    session._isAgentRunActive = true;
    return { session, rt, client, pendingSends, queueEvents };
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
    // SDK 原 _queueSteer 先发事件再写 native queue；桥在同一调用栈内延后事件，不误关操作。
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
    // 自动来源传输：经 runtime handleSend、真 prompt 异步输入处理、真双队列入队，始终不启动模型。
    const automaticCustom = { role: 'custom', customType: 'source-test', content: '保持原位', display: false, timestamp: Date.now() };
    for (const item of [a, b]) {
        item.session._runInputHandlers = async (text, images) => {
            await new Promise(resolve => setImmediate(resolve));
            return { text: text.replace('待变换', '变换后'), images };
        };
        item.session._expandSkillCommand = text => text;
    }
    setQueue(a, [], [], [automaticCustom], [automaticCustom]);
    const flush = async item => {
        const responses = await Promise.all(item.pendingSends.splice(0));
        assert(responses.every(response => response.success && response.data.disposition === 'queued'));
    };
    const sourceText = '【子会话结果】后台命令 #1 跑完了\n同文输入';
    const autoImage = { data: 'automatic-image', mimeType: 'image/png' };
    a.rt.handleSend(sourceText, undefined, { steer: true });
    a.rt.handleSend(sourceText); // 同文用户输入绝不能继承自动来源。
    a.rt.handleSend('待变换', [autoImage], { followUp: true });
    a.rt.streaming = false;
    a.rt.handleSend('待变换'); // 相同的异步变换结果，但这条是用户输入。
    a.rt.streaming = true;
    b.rt.handleSend(sourceText); // 不同会话的同文用户输入。
    await Promise.all([flush(a), flush(b)]);
    assert.deepEqual(a.rt.queuedSteering, [sourceText, sourceText]);
    assert.deepEqual(a.rt.queuedFollowUp, ['变换后', '变换后']);
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, [0]);
    assert.deepEqual(a.rt.queueSnapshot().hiddenFollowUp, [0]);
    assert.deepEqual(b.rt.queueSnapshot().hiddenSteering, []);
    const autoSteering = a.session.agent.steeringQueue.messages[1];
    const humanSteering = a.session.agent.steeringQueue.messages[2];
    const autoFollow = a.session.agent.followUpQueue.messages[1];
    assert.equal(autoSteering.content[0].text, sourceText);
    assert.equal(autoFollow.content[0].text, '变换后');
    assert.deepEqual(autoFollow.content[1], { type: 'image', ...autoImage });
    assert(a.queueEvents.some(event => event.steering.length === 1 && event.queueHiddenSteering[0] === 0));
    const beforeHiddenActions = commands.length;
    for (const kind of ['steering', 'followUp']) {
        for (const act of ['edit', 'cancel']) {
            const hiddenResult = await action(a, { kind, act, text: kind === 'steering' ? sourceText : '变换后', replacement: '不能改' });
            assert.equal(hiddenResult.success, false);
            assert.match(hiddenResult.error, /自动/);
        }
    }
    assert.equal(commands.length, beforeHiddenActions); // 后端拒绝，无内部命令发出。
    // 绕过后端，直接请求扩展命令也不能改隐藏对象。
    const sourceHandler = a.session.extensionRunner.getCommand(QUEUE_REMOVE_COMMAND).handler;
    const sourceCtx = a.session.extensionRunner.createCommandContext();
    const sourceNotify = sourceCtx.ui.notify;
    let hiddenDirect;
    sourceCtx.ui.notify = message => { hiddenDirect = decodeQueueResult(message); };
    for (const act of ['edit', 'cancel']) {
        sourceHandler(Buffer.from(JSON.stringify({ requestId: 'hidden-direct', act, kind: 'steering', index: 0,
            text: sourceText, revision: a.rt.queueRevision, nativeSessionId: a.session.sessionId, replacement: '不能改' })).toString('base64'), sourceCtx);
        assert.equal(hiddenDirect.success, false);
        assert.match(hiddenDirect.error, /自动/);
    }
    sourceCtx.ui.notify = sourceNotify;
    // 原摘要 index=1 的用户消息仍可修改，隐藏的 index=0 及其对象不变。
    assert.equal((await action(a, { index: 1, text: sourceText, act: 'edit', replacement: '用户修改' })).success, true);
    assert.equal(humanSteering.content[0].text, '用户修改');
    assert.equal(autoSteering.content[0].text, sourceText);
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, [0]);
    // 新用户消息插在自动结果之前，取消可见原索引后隐藏索引同步移位。
    setQueue(a, ['头条', sourceText, '用户修改'], ['变换后', '变换后'],
        [automaticCustom, user('头条'), autoSteering, humanSteering], [automaticCustom, autoFollow, a.session.agent.followUpQueue.messages[2]]);
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, [1]);
    assert.equal((await action(a, { text: '头条' })).success, true);
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, [0]);
    // 两条 native 同文跟进都被一次 drain 取走，摘要在 message_start 之前逐条缩短。
    a.session.agent.followUpQueue.mode = 'all';
    const drained = a.session.agent.followUpQueue.drain();
    assert.equal(drained[1], autoFollow);
    const refreshStatsSoon = a.rt.refreshStatsSoon;
    a.rt.refreshStatsSoon = () => {}; // message_start 的统计 RPC 不属于队列测试。
    await a.session._handleAgentEvent({ type: 'message_start', message: drained[1] });
    assert.deepEqual(a.rt.queuedFollowUp, ['变换后']);
    assert.deepEqual(a.rt.queueSnapshot().hiddenFollowUp, []);
    await a.session._handleAgentEvent({ type: 'message_start', message: drained[2] });
    // native 批量取走后，未投递的第二条自动结果仍隐藏。
    setQueue(a, [], [], [], []);
    a.rt.streaming = false;
    a.rt.handleSend('先投递的用户');
    a.rt.handleSend('稍后投递的自动结果', undefined, { followUp: true });
    await flush(a);
    const nextDrained = a.session.agent.followUpQueue.drain();
    await a.session._handleAgentEvent({ type: 'message_start', message: nextDrained[0] });
    assert.deepEqual(a.rt.queueSnapshot().hiddenFollowUp, [0]);
    await a.session._handleAgentEvent({ type: 'message_start', message: nextDrained[1] });
    assert.deepEqual(a.rt.queueSnapshot().hiddenFollowUp, []);
    a.rt.refreshStatsSoon = refreshStatsSoon;
    a.rt.streaming = true;
    // 来源标记只随对象生存：旧结果已投递，同文的新用户输入仍显示。
    a.rt.handleSend('稍后投递的自动结果');
    // 用户原样输入协议标记也会被转义，不能变成自动结果。
    const literalEnvelope = encodeQueuePrompt('用户输入的完整协议文字', true);
    a.rt.handleSend(literalEnvelope);
    a.rt.handleSend(QUEUE_PROMPT_PREFIX + 'not-base64');
    await flush(a);
    assert.deepEqual(a.rt.queuedSteering, ['稍后投递的自动结果', literalEnvelope, QUEUE_PROMPT_PREFIX + 'not-base64']);
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, []);
    // agent_settled 期间 SDK 延迟的 prompt 仍保留自动来源。
    a.session._isEmittingAgentSettled = true;
    await a.session.prompt(encodeQueuePrompt('延迟的自动结果', true), { source: 'rpc', streamingBehavior: 'steer' });
    a.session._isEmittingAgentSettled = false;
    for (const deferred of a.session._deferredSettledActions.splice(0)) { await deferred(); }
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, [3]);
    assert.equal(a.rt.queuedSteering[3], '延迟的自动结果');
    // 修改能力关闭不等于来源失效；冻结 native 队列仍应隐藏自动结果。
    Object.freeze(a.session.agent.steeringQueue.messages);
    a.session._emitQueueUpdate();
    assert.equal(a.rt.queueEditable, false);
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, [3]);
    // 自动空闲输入在 input hook 中被处理，不启动模型；hook 看到的始终是解码后的原文。
    b.session._isAgentRunActive = false;
    let idleInput;
    b.session._runInputHandlers = async text => { idleInput = text; return undefined; };
    await b.session.prompt(encodeQueuePrompt('空闲自动输入原文', true), { source: 'rpc', streamingBehavior: 'followUp' });
    assert.equal(idleInput, '空闲自动输入原文');
    b.session._isAgentRunActive = true;
    for (const item of [a, b]) {
        item.session._runInputHandlers = () => { throw new Error('禁止重新输入处理'); };
        item.session._expandSkillCommand = () => { throw new Error('禁止重新展开技能'); };
    }
    setQueue(a, [], [], [], []);
    a.rt.noteSessionReplaced();
    assert.deepEqual(a.rt.queueSnapshot().hiddenSteering, []);
    assert.deepEqual(a.rt.queueSnapshot().hiddenFollowUp, []);
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
    console.log('通过：自动结果显式传输/原文解码、异步并发/跨会话/同文用户来源隔离、隐藏原索引/双重拒绝/索引移位、批量投递及生命周期、真 pi SDK 双队列原位修改、重复原文指定 index、大图/custom/对象/顺序/时间戳保留、followUp 修改、cancel 删单条、陈旧/投递竞态拒绝、冻结/不可写无半更新、未知结构拒绝、跨会话与双页面定向结果、无模型/clear/重排/重新输入、reload 防模型回落。');
} finally {
    for (const session of sessions) { session._isAgentRunActive = false; session.dispose(); }
    host.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
}
