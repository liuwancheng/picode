// @ts-nocheck
/**
 * sendButton —— 验输入框右下角那颗发送键。
 *
 *   npm run web:shot -- --fake-pi --width 420 --height 900 --script dev/sendButton.js
 *
 * 为什么要有它：电脑上是回车发送（见 media/chat.js 的 isSendKey），手机上没有回车 ——
 * 输入法那颗回车不一定发得出去（发送键还能被设成 Ctrl+Enter，那就更没法发）。
 *
 * 验四件事：一颗真的摆出来了（在最右头、点得到）、空输入时灰着、打了字就亮、
 * 点一下真把内容发出去（发完输入框清空、又灰回去）。
 */
module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(500);

    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };
    const button = () => page.eval(`
        const el = document.getElementById("sendBtn");
        if (!el) { return null; }
        const r = el.getBoundingClientRect();
        const row = document.getElementById("inputRow");
        return {
            disabled: el.disabled,
            w: Math.round(r.width), h: Math.round(r.height),
            last: row.lastElementChild === el,
            right: Math.round(r.right), win: Math.round(innerWidth),
        };
    `);

    const empty = await button();
    check(!!empty, "找不到发送键");
    if (empty) {
        check(empty.disabled === true, "空输入时发送键没灰着");
        check(empty.w >= 24 && empty.h >= 24, `发送键太小（${empty.w}×${empty.h}）`);
        check(empty.last === true, "发送键没摆在输入框那条横排的最右头");
        check(empty.right <= empty.win, "发送键跑到屏幕外面去了");
    }
    console.log("  一、空输入：摆着、灰着、在最右头");
    await page.shot("send-button-empty.png");

    // 打了字就亮起来
    await page.eval(`
        const el = document.getElementById("input");
        el.value = "从手机发的一句";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    `);
    await page.sleep(300);
    const typed = await button();
    check(typed && typed.disabled === false, "打了字以后发送键还是灰的");
    console.log("  二、打了字：亮起来");
    await page.shot("send-button-typed.png");

    // 点一下真发出去
    await page.click("#sendBtn");
    await page.waitText("从手机发的一句", 15000);
    const after = await page.eval(`return {
        value: document.getElementById("input").value,
        disabled: document.getElementById("sendBtn").disabled,
    };`);
    check(after.value === "", "发出去以后输入框没清空");
    check(after.disabled === true, "发出去以后发送键没灰回去");
    console.log("  三、点一下：发出去了，输入框清空、键又灰回去");
    await page.shot("send-button-sent.png");

    if (problems.length) { throw new Error("发送键没过：" + problems.join("；")); }
    console.log("\n  对了：发送键摆着、灰着、亮起来、点一下真发出去。");
};
