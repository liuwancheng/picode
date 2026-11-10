/** 固定传输标记：多个后端可共用桥文件；用户输入同一标记时转义，来源不靠正文猜。 */
export const QUEUE_PROMPT_PREFIX = "__PICHAT_QUEUE_PROMPT__:";
export function encodeQueuePrompt(text: string, automatic: boolean): string {
    if (!automatic && !text.startsWith(QUEUE_PROMPT_PREFIX)) { return text; }
    return QUEUE_PROMPT_PREFIX + Buffer.from(JSON.stringify({ text, automatic }), "utf8").toString("base64");
}

/** 逐条修改/取消排队消息：只在 pi 已确认的双队列结构上同步操作，不清空重排。 */
export const QUEUE_REMOVE_COMMAND = "pichat-queue-remove";
export const QUEUE_RESULT_PREFIX = "__PICHAT_QUEUE_RESULT__:";

export interface QueueActionRequest {
    requestId: string;
    act: "edit" | "cancel";
    kind: "steering" | "followUp";
    index: number;
    text: string;
    revision: number;
    /** edit 必须提供非空文本，保存时保留原有空白；cancel 不使用。 */
    replacement?: string;
}

export interface QueueActionResult {
    requestId: string;
    act: "edit" | "cancel";
    success: boolean;
    text?: string;
    error?: string;
}

export function isQueueActionRequest(value: any): value is QueueActionRequest {
    return !!value && typeof value.requestId === "string" && value.requestId.length > 0
        && (value.act === "edit" || value.act === "cancel")
        && (value.kind === "steering" || value.kind === "followUp")
        && Number.isSafeInteger(value.index) && value.index >= 0
        && typeof value.text === "string"
        && Number.isSafeInteger(value.revision) && value.revision >= 0
        && (value.act !== "edit" || (typeof value.replacement === "string" && value.replacement.trim().length > 0));
}

/** 此 notify 只给后端认领，不显示成系统消息，也不携带附件。 */
export function decodeQueueResult(message: string): QueueActionResult | undefined {
    try {
        const result = JSON.parse(Buffer.from(message.slice(QUEUE_RESULT_PREFIX.length), "base64").toString("utf8"));
        if (typeof result.requestId !== "string" || (result.act !== "edit" && result.act !== "cancel")
            || typeof result.success !== "boolean") { return undefined; }
        if (result.success && result.act === "edit" && typeof result.text !== "string") { return undefined; }
        if (!result.success && typeof result.error !== "string") { return undefined; }
        return { requestId: result.requestId, act: result.act, success: result.success,
            ...(result.success && result.act === "edit" ? { text: result.text } : {}),
            ...(!result.success ? { error: result.error } : {}) };
    } catch { return undefined; }
}

/** 独立文件的价值：封住 pi 私有结构依赖；结构变化就关掉操作，其他桥与显示队列不受影响。 */
export const QUEUE_BRIDGE_SOURCE = String.raw`
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
const PROMPT_PREFIX = ${JSON.stringify(QUEUE_PROMPT_PREFIX)};
const COMMAND = ${JSON.stringify(QUEUE_REMOVE_COMMAND)};
const RESULT_PREFIX = ${JSON.stringify(QUEUE_RESULT_PREFIX)};
const KEY = Symbol.for("pichat.queueBridge.v2");

function mutableArray(value) {
    return Array.isArray(value) && Object.isExtensible(value) && !Object.isSealed(value)
        && Object.getOwnPropertyDescriptor(value, "length")?.writable
        && Object.getOwnPropertyNames(value).filter(key => key !== "length").every(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor && descriptor.writable && descriptor.configurable;
        });
}

function shape(session) {
    const agent = session.agent;
    return session.sessionManager && typeof session.sessionManager.getSessionId === "function"
        && typeof session._emitQueueUpdate === "function"
        && mutableArray(session._steeringMessages) && session._steeringMessages.every(text => typeof text === "string")
        && mutableArray(session._followUpMessages) && session._followUpMessages.every(text => typeof text === "string")
        && agent && [agent.steeringQueue, agent.followUpQueue].every(queue =>
            queue && (queue.mode === "all" || queue.mode === "one-at-a-time") && mutableArray(queue.messages))
        && session._steeringMessages !== session._followUpMessages
        && agent.steeringQueue.messages !== agent.followUpQueue.messages;
}

// 只认 native user 的首文本块与后续图片；遇未知 user 内容就拒绝，custom 留在原位置。
function userContent(message) {
    if (!message || message.role !== "user" || !Array.isArray(message.content)
        || message.content[0]?.type !== "text" || typeof message.content[0].text !== "string"
        || message.content.slice(1).some(block => !block || block.type !== "image"
            || typeof block.data !== "string" || typeof block.mimeType !== "string")) { return undefined; }
    return message.content[0];
}

function nativeIndices(texts, messages) {
    const indices = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || typeof message.role !== "string") { return undefined; }
        if (message.role !== "user") { continue; }
        const content = userContent(message);
        if (!content || content.text !== texts[indices.length]) { return undefined; }
        indices.push(index);
    }
    return indices.length === texts.length ? indices : undefined;
}

// native drain 可一次取走多条，AgentSession 的摘要却在 message_start 时逐条移除。
// 保留上一份摘要对应的消息对象直到它被移除；来源只来自 WeakSet，不来自文字。
function hiddenIndices(state, session, kind, texts, messages) {
    let views = state.views.get(session);
    if (!views) { views = {}; state.views.set(session, views); }
    const native = Array.isArray(messages) ? nativeIndices(texts, messages) : undefined;
    let users = native?.map(index => messages[index]);
    const previous = views[kind];
    if (!users && previous) {
        if (texts.length === previous.texts.length
            && texts.every((text, index) => text === previous.texts[index])) {
            users = previous.users;
        } else if (texts.length === previous.texts.length - 1) {
            // SDK 用 indexOf 移除首个同文摘要，重复原文也按相同规则对齐对象。
            const removed = previous.texts.findIndex((_text, index) =>
                texts.every((text, next) => text === previous.texts[next < index ? next : next + 1]));
            if (removed >= 0) { users = previous.users.filter((_message, index) => index !== removed); }
        }
    }
    if (!users) { delete views[kind]; return []; }
    views[kind] = { texts: texts.slice(), users };
    return users.flatMap((message, index) => state.hidden.has(message) ? [index] : []);
}

function install() {
    const proto = AgentSession?.prototype;
    if (!proto || ["_emit", "prompt", "_queueSteer", "_queueFollowUp"].some(name => typeof proto[name] !== "function")) {
        return undefined;
    }
    if (proto[KEY]) { return proto[KEY]; }
    const state = { sessions: new Map(), handlers: new WeakSet(), hidden: new WeakSet(),
        views: new WeakMap(), context: new AsyncLocalStorage(),
        // 新进程/新会话不复用旧 revision；仍在安全整数范围内，每个 queue_update 递增。
        revision: Date.now() * 1000 + Math.floor(Math.random() * 1000) };
    const emit = proto._emit;
    const prompt = proto.prompt;
    proto._emit = function(event) {
        if (event?.type === "queue_update") {
            const call = state.context.getStore();
            if (call?.session === this && call.kind && !call.flushing) {
                call.events.push(event);
                return;
            }
            if (call?.session === this && call.kind && call.automatic) {
                const messages = call.kind === "steering" ? this.agent?.steeringQueue?.messages : this.agent?.followUpQueue?.messages;
                // 已核对的 SDK 在同步调用内只追加一条 native user，绝不按正文匹配来源。
                if (Array.isArray(messages) && messages.length === call.before.length + 1
                    && call.before.every((message, index) => message === messages[index])
                    && messages[messages.length - 1]?.role === "user") {
                    state.hidden.add(messages[messages.length - 1]);
                }
            }
            const revision = ++state.revision;
            state.sessions.set(this.sessionManager, { session: this, revision });
            let editable = false;
            let sessionId;
            let hiddenSteering = [], hiddenFollowUp = [];
            try {
                editable = !!shape(this);
                hiddenSteering = hiddenIndices(state, this, "steering", event.steering, this.agent?.steeringQueue?.messages);
                hiddenFollowUp = hiddenIndices(state, this, "followUp", event.followUp, this.agent?.followUpQueue?.messages);
                if (typeof this.sessionManager?.getSessionId === "function") {
                    sessionId = this.sessionManager.getSessionId();
                }
            } catch { /* 未知结构不影响队列显示 */ }
            event = { ...event, queueRevision: revision, queueEditable: editable, queueSessionId: sessionId,
                queueHiddenSteering: hiddenSteering, queueHiddenFollowUp: hiddenFollowUp };
        }
        return emit.call(this, event);
    };
    for (const [name, kind] of [["_queueSteer", "steering"], ["_queueFollowUp", "followUp"]]) {
        const queue = proto[name];
        proto[name] = function(...args) {
            const parent = state.context.getStore();
            const messages = kind === "steering" ? this.agent?.steeringQueue?.messages : this.agent?.followUpQueue?.messages;
            const call = { session: this, kind, automatic: parent?.session === this && parent.automatic === true,
                before: Array.isArray(messages) ? messages.slice() : [], events: [], flushing: false };
            return state.context.run(call, () => {
                try { return queue.apply(this, args); }
                finally {
                    // SDK 1.5.0 虽返回 Promise，入队与发事件均无 await；同一调用栈内完成转发。
                    call.flushing = true;
                    for (const event of call.events) { this._emit(event); }
                }
            });
        };
    }
    // get_commands 与 prompt 之间可能 /reload。内部命令若消失或被别的扩展顶掉，绝不退回模型。
    proto.prompt = function(text, options) {
        // SDK 会推迟 agent_settled 订阅者发出的输入；让它保存传输载荷，稍后再解码。
        if (this._isEmittingAgentSettled) { return prompt.call(this, text, options); }
        let automatic = false;
        if (typeof text === "string" && text.startsWith(PROMPT_PREFIX)) {
            try {
                const encoded = text.slice(PROMPT_PREFIX.length);
                const buffer = Buffer.from(encoded, "base64");
                const payload = JSON.parse(buffer.toString("utf8"));
                if (buffer.toString("base64") === encoded && typeof payload.text === "string"
                    && typeof payload.automatic === "boolean") {
                    text = payload.text;
                    automatic = payload.automatic;
                }
            } catch { /* 非协议载荷仍是普通用户原文 */ }
        }
        if (typeof text === "string" && (text === "/" + COMMAND || text.startsWith("/" + COMMAND + " "))) {
            const command = this._extensionRunner?.getCommand?.(COMMAND);
            if (!command || !state.handlers.has(command.handler)) {
                return Promise.reject(new Error("排队操作桥已失效，请刷新后重试"));
            }
            return prompt.call(this, text, { ...options, expandPromptTemplates: true });
        }
        // 每次 prompt 都建独立作用域，异步 input 处理、同文输入与并发会话互不污染。
        return state.context.run({ session: this, automatic }, () => prompt.call(this, text, options));
    };
    Object.defineProperty(proto, KEY, { value: state });
    return state;
}

export default function queueBridge(pi) {
    const state = install();
    function handler(args, ctx) {
        let request;
        let result;
        try {
            request = JSON.parse(Buffer.from(args, "base64").toString("utf8"));
            result = { requestId: request.requestId, act: request.act, success: false };
            if (typeof request.requestId !== "string" || !request.requestId
                || (request.act !== "edit" && request.act !== "cancel")
                || (request.kind !== "steering" && request.kind !== "followUp")
                || !Number.isSafeInteger(request.index) || request.index < 0
                || typeof request.text !== "string" || !Number.isSafeInteger(request.revision) || request.revision < 0
                || (request.act === "edit" && (typeof request.replacement !== "string" || !request.replacement.trim()))
                || typeof request.nativeSessionId !== "string" || !request.nativeSessionId) {
                throw new Error("排队操作参数无效");
            }
            const bound = state?.sessions.get(ctx.sessionManager);
            const session = bound?.session;
            if (!session || session.sessionManager !== ctx.sessionManager || !shape(session)) {
                throw new Error("当前 pi 的排队结构不支持逐条操作");
            }
            if (ctx.sessionManager.getSessionId() !== request.nativeSessionId) {
                throw new Error("会话已经切换，请刷新后重试");
            }
            if (bound.revision !== request.revision) {
                throw new Error("排队消息已经变化，请按最新队列重试");
            }
            const steering = nativeIndices(session._steeringMessages, session.agent.steeringQueue.messages);
            const followUp = nativeIndices(session._followUpMessages, session.agent.followUpQueue.messages);
            if (!steering || !followUp) { throw new Error("排队消息正在投递或结构不匹配，请稍后重试"); }
            const texts = request.kind === "steering" ? session._steeringMessages : session._followUpMessages;
            const messages = request.kind === "steering" ? session.agent.steeringQueue.messages : session.agent.followUpQueue.messages;
            const indices = request.kind === "steering" ? steering : followUp;
            if (texts[request.index] !== request.text || request.index >= indices.length) {
                throw new Error("这条排队消息已经变化，请按最新队列重试");
            }
            const message = messages[indices[request.index]];
            if (state.hidden.has(message)) { throw new Error("自动排队消息不支持修改或取消"); }
            const content = userContent(message);
            if (request.act === "edit") {
                const textField = Object.getOwnPropertyDescriptor(content, "text");
                const summaryField = Object.getOwnPropertyDescriptor(texts, String(request.index));
                if (Object.isFrozen(message) || Object.isFrozen(message.content)
                    || message.content.some(block => Object.isFrozen(block))
                    || !textField?.writable || !summaryField?.writable) {
                    throw new Error("这条排队消息已被冻结或文本不可写，请刷新后重试");
                }
                // 未知的共享文本块可能连带修改另一条消息，安全拒绝。
                const users = session.agent.steeringQueue.messages.concat(session.agent.followUpQueue.messages)
                    .filter(item => item?.role === "user" && item.content?.[0] === content);
                if (users.length !== 1) { throw new Error("排队消息结构不支持独立修改"); }
                // 两个可写的数据字段均已核对；中间没有 await，不重跑输入处理或入队。
                content.text = request.replacement;
                texts[request.index] = request.replacement;
                result = { ...result, success: true, text: request.replacement };
            } else {
                // 核对与双 splice 之间没有 await：保留其他消息对象、图片、custom 及顺序。
                Array.prototype.splice.call(messages, indices[request.index], 1);
                Array.prototype.splice.call(texts, request.index, 1);
                result = { ...result, success: true };
            }
            // mutation 已完成时，某个订阅者异常不能把成功误报成失败。
            try { session._emitQueueUpdate(); } catch { /* 双队列已同步 */ }
        } catch (error) {
            result = { requestId: request?.requestId || "", act: request?.act || "cancel",
                success: false, error: error instanceof Error ? error.message : String(error) };
        }
        ctx.ui.notify(RESULT_PREFIX + Buffer.from(JSON.stringify(result), "utf8").toString("base64"), "info");
    }
    if (state) { state.handlers.add(handler); }
    pi.registerCommand(COMMAND, { description: "Pi Chat 内部逐条排队操作", handler });
    pi.on("session_shutdown", (_event, ctx) => { state?.sessions.delete(ctx.sessionManager); });
}
`;
