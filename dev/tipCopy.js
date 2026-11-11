// @ts-nocheck
/**
 * tipCopy —— 验提示框里每一条标题行右边的「复制」（think 这类条目以前只能自己拿鼠标划着选）。
 *
 *   npm run web:shot -- --width 1000 --height 760 --script dev/tipCopy.js
 * 图落在 dev/shots/。
 *
 * 验这几件事：
 *   · 每一条调用行右边都有一颗复制按钮（think 的几个条目、bash 的都算）；
 *   · 点它不会把那一行当成「铺开 / 收起」点了（铺开的结果块数一点没变）；
 *   · 整段已经带过来的：复制到的就是这一条的字（连换行都在），按钮打勾；
 *   · 全文还留在后端（只有字数 + 编号）的：点一下先去取（loadDetails 发出去了），
 *     取到了自动复制上，不用再点第二次；
 *   · 没有内容的那种（调用行之外什么都没有）不假报成功。
 */
const INLINE = "第一段：先看要改哪几处。\n第二段：改完再验一遍。";
const CLIPPED = "这一段的全文还留在后端，点开才取回来。\n（第二行，验换行有没有一起复制走）";

/** 往页面里投一批后端消息（跟后端推给页面的形状一样）。 */
function post(page, messages) {
    return page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
}

/** 点开「工具名」那颗标签的提示框。 */
function openNamed(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-row .tool-group"))
            .filter((t) => { const n = t.querySelector(".tg-name"); return n && n.textContent === " " + ${JSON.stringify(name)}; })
            .pop();
        if (!el) { throw new Error("页面上没有这个标签：" + ${JSON.stringify(name)}); }
        el.click();
        return true;
    `);
}

/** 提示框里现在长什么样：几条输入、几块铺开的结果、几颗复制按钮、各条标题写的是什么。 */
function tipState(page) {
    return page.eval(`
        const el = document.querySelector(".tag-tip");
        if (!el || el.classList.contains("hidden")) { return JSON.stringify({ open: false }); }
        return JSON.stringify({
            open: true,
            inputs: el.querySelectorAll(".tag-tip-click").length,
            outputs: el.querySelectorAll(".tag-tip-result").length,
            copies: el.querySelectorAll(".tip-copy").length,
            rows: Array.from(el.querySelectorAll(".tag-tip-head .tag-tip-title")).map((t) => t.textContent),
        });
    `).then(JSON.parse);
}

/** 点第 i 颗复制按钮（真按钮、真点击事件）。 */
function clickCopy(page, i) {
    return page.eval(`
        const btns = document.querySelectorAll(".tag-tip .tip-copy");
        const btn = btns[${i}];
        if (!btn) { throw new Error("提示框里没有第 " + ${i} + " 颗复制按钮"); }
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
    `);
}

/** 现在已经复制到手的东西，和提示框里每颗按钮上的反馈。 */
function copyState(page) {
    return page.eval(`return JSON.stringify({
        copied: window.__copied || [],
        titles: Array.from(document.querySelectorAll(".tag-tip .tip-copy")).map((b) => b.title),
        loads: window.__loads || 0,
    });`).then(JSON.parse);
}

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const need = (ok, why) => { if (!ok) { problems.push(why); } };

    // 剪贴板换成一只兜子：无头浏览器拿不到系统剪贴板，这里只看“交给剪贴板的到底是什么字”。
    // loadDetails 也拦下来（不让它真去问后端）：这一条的内容由下面自己当后端投回来。
    await page.eval(`
        window.__copied = [];
        window.__loads = 0;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: async (t) => { window.__copied.push(t); },
        } });
        const api = acquireVsCodeApi();   // 同一个对象（桥里只造一份）：改它上面的 postMessage 就行
        const orig = api.postMessage;
        api.postMessage = function (m) {
            if (m && m.type === "loadDetails") { window.__loads++; return; }
            return orig.apply(this, arguments);
        };
        return true;`);

    // 两段思考：一段整段带过来，一段全文还留在后端（只给字数 + 编号）
    await post(page, [
        { type: "assistantFull", text: "想一下：" },
        { type: "thinkingStart" },
        { type: "thinkingFull", text: INLINE },
        { type: "thinkingStart" },
        { type: "thinkingFull", text: "", omitted: CLIPPED.length, detailKey: "think-clip" },
        { type: "assistantFull", text: "开始动手。" },
    ]);
    await page.sleep(400);

    // ---- 一、每条调用行右边都有一颗复制按钮 ----
    await openNamed(page, "think");
    await page.sleep(300);
    const opened = await tipState(page);
    console.log("\n一、点开 think（每条调用行右边一颗复制按钮）：\n  输入 " + opened.inputs + " 行，复制按钮 "
        + opened.copies + " 颗，标题：" + JSON.stringify(opened.rows));
    await page.shot("tip-copy-buttons.png");
    need(opened.open, "点开 think 之后提示框没出来");
    need(opened.copies === opened.inputs, "复制按钮跟调用行不是一行一颗（" + opened.copies + " / " + opened.inputs + "）");

    // ---- 二、整段带过来的那一条：点复制，字原样到手，且没把这一行当展开 / 收起点 ----
    await clickCopy(page, 0);
    await page.sleep(200);
    const afterCopy = await copyState(page);
    const stillClosed = await tipState(page);
    console.log("\n二、点第一颗复制（整段带过来的那一条）：\n  复制到 " + JSON.stringify(afterCopy.copied)
        + "\n  按钮写着" + JSON.stringify(afterCopy.titles) + "，铺开的结果 " + stillClosed.outputs + " 块（点之前 "
        + opened.outputs + " 块）");
    need(afterCopy.copied.length === 1 && afterCopy.copied[0] === INLINE,
        "复制到的不是这一条的原样文字：" + JSON.stringify(afterCopy.copied));
    need(afterCopy.titles[0] === "已复制", "复制按钮没打勾：" + afterCopy.titles[0]);
    need(stillClosed.outputs === opened.outputs, "点复制把那一行当成展开 / 收起点了：" + JSON.stringify(stillClosed));

    // ---- 三、全文还在后端的那一条：点一下先去取，取到了自动复制上 ----
    await clickCopy(page, 1);
    await page.sleep(200);
    const pending = await copyState(page);
    const fetching = await tipState(page);
    console.log("\n三、点全文还在后端那一条的复制（该先去取）：\n  问后端的次数 " + pending.loads
        + "，按钮写着" + JSON.stringify(pending.titles) + "，这一刻铺开的结果 " + fetching.outputs + " 块");
    need(pending.loads === 1, "点复制没有去后端要全文（loadDetails 没发出去）");
    need(pending.titles[1] === "正在取回全文…", "取全文期间按钮没说清在等：" + pending.titles[1]);

    // 后端把全文投回来
    await post(page, [{ type: "details", items: { "think-clip": CLIPPED }, missing: [] }]);
    await page.sleep(400);
    const fetched = await copyState(page);
    console.log("  全文回来之后：复制到 " + JSON.stringify(fetched.copied.slice(-1)));
    await page.shot("tip-copy-fetched.png");
    need(fetched.copied.length === 2 && fetched.copied[1] === CLIPPED,
        "取回的全文没有自动复制上：" + JSON.stringify(fetched.copied));

    console.log(problems.length === 0 ? "\n提示框里的复制：都对。" : "\n有问题：\n- " + problems.join("\n- "));
    if (problems.length > 0) { throw new Error(problems.join("；")); }
};
