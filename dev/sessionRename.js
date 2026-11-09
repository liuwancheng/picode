// 工作区会话的「… → 重命名」：假数据，不请求模型。
// npm run web:shot -- --fake-pi --width 1200 --height 760 --script dev/sessionRename.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

module.exports = async (page, { host }) => {
  const assert = (ok, text) => { if (!ok) { throw new Error(text); } console.log("✓ " + text); };
  const wait = async (code, text) => {
    for (let i = 0; i < 100; i++) {
      if (await page.eval(code)) { return; }
      await page.sleep(100);
    }
    await page.shot("session-rename-failed.png");
    const detail = await page.eval('return document.querySelector(".session-rename-panel")?.innerText || document.getElementById("dockBody").innerText;');
    throw new Error(text + "\n" + detail);
  };
  const post = (msg) => page.eval(`window.acquireVsCodeApi().postMessage(${JSON.stringify(msg)}); return true;`);
  const cwd = await page.eval('return document.getElementById("sessionName").dataset.cwd;');
  const root = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions");
  const dir = path.join(root, "--" + cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-") + "--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rename-test-" + randomUUID() + ".jsonl");
  const id = randomUUID();
  fs.writeFileSync(file, [
    { type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() },
    { type: "message", id: "first", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "待整理的历史会话" } },
  ].map(JSON.stringify).join("\n") + "\n");
  const count = host.panels.size;
  const active = await page.eval('return document.getElementById("sessionName").dataset.sessionId || document.getElementById("sessionName").dataset.idx;');
  const row = '#sidebarDock .pk-group-session[data-file=' + JSON.stringify(file) + ']';
  const title = 'document.querySelector(' + JSON.stringify(row + " .pk-history-title") + ')';
  const choose = async () => {
    await page.click(row + " .pk-session-more");
    await page.click('.session-menu [role="menuitem"]');
  };
  const typeName = async (text) => {
    await page.eval('const i = document.getElementById("sessionRenameInput"); i.focus(); i.select(); return true;');
    await page.cdp.send("Input.insertText", { text });
  };
  try {
    require("../out/server/sessionStore.js").dropSessionFileLists([cwd]);
    await post({ type: "openWorkspace", dock: true, expanded: [cwd] });
    await post({ type: "workspaceSessions", path: cwd, offset: 0 });
    await wait(`return !!${title};`, "历史会话没有出现在当前工作区");
    await page.click(row + " .pk-session-more");
    assert(await page.eval('return !!document.querySelector(".session-menu");'), "菜单已打开");
    await page.eval('document.querySelector(".session-pane").dispatchEvent(new Event("scroll")); return true;');
    assert(await page.eval('return !!document.querySelector(".session-menu");'), "对话滚动不关闭会话菜单");
    await page.shot("session-rename-menu.png");
    await page.press("Escape");
    assert(await page.eval('return !document.querySelector(".session-menu");'), "Esc 只关菜单");
    await choose();
    assert(await page.eval('return document.getElementById("sessionRenameInput").value === "待整理的历史会话";'), "弹窗预填旧名称");
    await page.shot("session-rename-dialog.png");
    await page.eval('document.getElementById("sessionRenameInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })); return true;');
    assert(await page.eval('return !!document.getElementById("sessionRenameOverlay");'), "输入法确认候选字时不提交");
    await page.eval('document.getElementById("sessionRenameInput").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); return true;');
    await page.press("Escape");
    assert(await page.eval('return !!document.getElementById("sessionRenameOverlay");'), "输入法取消候选字时不关闭弹窗");
    await page.eval('document.getElementById("sessionRenameInput").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); return true;');
    await typeName("放弃这个名字");
    await page.click(".session-rename-cancel");
    assert(await page.eval(`return ${title}.textContent === "待整理的历史会话";`), "取消不改变名称");
    await choose();
    await typeName("   ");
    assert(await page.eval('return document.querySelector(".session-rename-save").disabled;'), "空白名称不能保存");
    const name = "发布计划 · 手动整理";
    await typeName("  " + name + "  ");
    await page.press("Enter");
    await wait(`return !document.getElementById("sessionRenameOverlay") && ${title}.textContent === ${JSON.stringify(name)};`, "历史会话改名未成功");
    assert(await page.eval('return !!document.activeElement.closest(".pk-host") && document.activeElement.classList.contains("pk-session-more");'), "保存后焦点留在会话列表");
    assert(host.panels.size === count, "未打开的历史会话改名不启动会话");
    const after = await page.eval('return document.getElementById("sessionName").dataset.sessionId || document.getElementById("sessionName").dataset.idx;');
    assert(active === after, "改名不切换当前会话");
    assert(fs.readFileSync(file, "utf8").includes('"name":"' + name + '"'), "新名称写入会话文件");
    await page.shot("session-rename-saved.png");

    // 文件在弹窗打开后被删：失败不能假装已保存，保留输入、允许取消。
    await choose();
    const savedFile = fs.readFileSync(file, "utf8");
    fs.rmSync(file);
    await typeName("不该保存成功");
    await page.click(".session-rename-save");
    await wait('return !!document.querySelector(".session-rename-error")?.textContent;', "保存失败没有显示原因");
    assert(await page.eval('return document.getElementById("sessionRenameInput").value === "不该保存成功" && !document.getElementById("sessionRenameInput").disabled;'), "保存失败保留输入并恢复操作");
    await page.click(".session-rename-cancel");
    fs.writeFileSync(file, savedFile);

    // 别的页面给尚未加载的老会话改名：磁盘排序改变后，这页不能沿着旧游标漏掉它。
    const extra = [];
    try {
      for (let i = 0; i < 6; i++) {
        const f = path.join(dir, "rename-page-" + randomUUID() + ".jsonl");
        fs.writeFileSync(f, [
          { type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date().toISOString() },
          { type: "message", id: "first", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "分页会话 " + i } },
        ].map(JSON.stringify).join("\n") + "\n");
        const stamp = new Date(Date.now() - (i + 1) * 60000);
        fs.utimesSync(f, stamp, stamp); extra.push(f);
      }
      require("../out/server/sessionStore.js").dropSessionFileLists([cwd]);
      await post({ type: "workspaceSessions", path: cwd, offset: 0 });
      await wait('return !!document.querySelector("#sidebarDock .pk-group-more");', "没有分页用加载更多");
      const unseen = extra.at(-1);
      const unseenRow = '#sidebarDock .pk-group-session[data-file=' + JSON.stringify(unseen) + ']';
      assert(!await page.eval(`return !!document.querySelector(${JSON.stringify(unseenRow)});`), "老会话尚未加载");
      await post({ type: "renameSession", path: unseen, cwd, name: "跨页面改名后进入第一页", requestId: "external-rename" });
      await wait(`return document.querySelector(${JSON.stringify(unseenRow + " .pk-history-title")})?.textContent === "跨页面改名后进入第一页";`, "改名导致排序变化后漏掉未加载会话");
      console.log("✓ 未加载会话改名后重新同步分页");
    } finally { extra.forEach((f) => fs.rmSync(f, { force: true })); }

    // 假置生成状态：关菜单 / 弹窗不能把这一轮一起中止。
    const rt = Array.from(host.panels.values())[0];
    rt.streaming = true;
    host.broadcastSessionList(true);
    await page.click("#sidebarDock .pk-open.current .pk-session-more");
    await page.press("Escape");
    assert(rt.streaming, "关菜单不停止生成");
    await page.click("#sidebarDock .pk-open.current .pk-session-more");
    await page.click('.session-menu [role="menuitem"]');
    await page.press("Escape");
    assert(rt.streaming, "关弹窗不停止生成");
    rt.streaming = false;
    host.broadcastSessionList(true);

    // 活动会话经原生 RPC 设名，顶条与两处列表同步。
    await page.click("#sidebarDock .pk-open.current .pk-session-more");
    await page.click('.session-menu [role="menuitem"]');
    await typeName("正在处理的计划");
    await page.press("Enter");
    await wait('return !document.getElementById("sessionRenameOverlay") && document.querySelector("#sessionName .sn-text").textContent === "正在处理的计划";', "活动会话改名未成功");
    assert(await page.eval('return document.querySelector("#sidebarDock .pk-open.current .pk-history-title").textContent === "正在处理的计划";'), "活动会话顶条与列表同步");

    await page.cdp.send("Page.reload", {});
    await page.waitReady();
    await wait(`return ${title} && ${title}.textContent === ${JSON.stringify(name)};`, "刷新后历史会话名称丢失");
    assert(await page.eval('return document.querySelector("#sessionName .sn-text").textContent === "正在处理的计划";'), "刷新后活动会话名称不丢");
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: true });
    await page.eval('window.pichatSidebar.toggle(); return true;');
    await wait('return !!document.querySelector("#pickerOverlay .pk-group-session .pk-session-more");', "窄窗没有会话菜单");
    await page.click("#pickerOverlay .pk-group-session .pk-session-more");
    await page.shot("session-rename-mobile-menu.png");
    const inView = await page.eval('const r = document.querySelector(".session-menu").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;');
    assert(inView, "窄窗菜单不出屏");
    await page.click('.session-menu [role="menuitem"]');
    await page.shot("session-rename-mobile-dialog.png");
    await page.press("Escape");
    assert(await page.eval('return !document.getElementById("sessionRenameOverlay") && !document.getElementById("pickerOverlay").classList.contains("hidden");'), "Esc 只关改名弹窗，保留工作区清单");
    assert(!(page.pageErrors || []).length, "页面无异常");
  } finally {
    fs.rmSync(file, { force: true });
    require("../out/server/sessionStore.js").dropSessionFileLists([cwd]);
  }
};
