// @ts-nocheck
/**
 * 点文件链接的候选与打开解析：node dev/linkCandidates.js（先 npm run compile）。
 * 只用临时目录与直接 fs 生成的素材模拟 bash 产物，不登记 knownFiles，不起模型。
 * 验优先级、ignore 产物定向兜底、歧义、glob 字面匹配、大小写、预算与原 403 边界。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");

const OUT = path.resolve(__dirname, "..", "out", "server", "fileSearch.js");
if (!fs.existsSync(OUT)) {
    console.error("还没编译：找不到 out/server/fileSearch.js。先跑 npm run compile。");
    process.exit(1);
}
const { findPathCandidates, findListedFile, findFileNames, findFileContents } = require(OUT);
const { PiChatWebServer } = require(path.join(path.dirname(OUT), "webChatServer.js"));
const { pathCaseKey } = require(path.join(path.dirname(OUT), "pathRules.js"));

let bad = 0;
let checked = 0;
function check(name, ok, extra) {
    checked++;
    console.log("  " + (ok ? "✓" : "✗") + " " + name + (extra === undefined ? "" : "：" + extra));
    if (!ok) { bad++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-link-candidates-"));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-link-candidates-outside-"));
const ignored = "Reverse/_work";
const artifact = ignored + "/sessions/hash/reviews/Checks.tmo.final02.json";
function write(rel, text = "// " + rel + "\n") {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf8");
    return full;
}

// 隔离编译后的模块来模拟 rg 不可用 / 超时；只在测试内查看内部 FileList 的截断状态。
// 不改生产导出、环境变量或全局 fs，也不需要新增测试文件。
function isolatedSearch(overrides = {}) {
    const localRequire = createRequire(OUT);
    const module = { exports: {} };
    const sandbox = {
        module, exports: module.exports, process, console, setTimeout, clearTimeout,
        ...overrides,
        require: (id) => id === "child_process" && overrides.spawn
            ? { spawn: overrides.spawn }
            : id === "fs" && overrides.fs ? overrides.fs : localRequire(id),
    };
    vm.runInNewContext(fs.readFileSync(OUT, "utf8")
        + "\nmodule.exports.targeted = findBasenameFiles;", sandbox, { filename: OUT });
    return module.exports;
}
const missingRg = () => { throw Object.assign(new Error("模拟没装 rg"), { code: "ENOENT" }); };

(async () => {
    write(".gitignore", "Reverse/_work/\n.hidden-build/\nlate/\n");
    write(".ignore", "local-build/\n");
    write("exact.js");
    write(ignored + "/exact.js");
    const deepKnown = write("deep/pick.js");
    write("deep2/pick.js");
    write(ignored + "/pick.js");
    write("deep/nested/only-here.js");
    const inModules = write("node_modules/known-in-modules.js");
    write("other/deleted-twin.js");
    const goneKnown = write("gone/deleted-twin.js");
    fs.rmSync(goneKnown);
    const knownOutside = path.join(outsideRoot, "outside-only.js");
    fs.writeFileSync(knownOutside, "// 会话目录外面那个\n", "utf8");
    write(artifact, "{\"generatedByBash\":\"忽略产物独有文字\"}\n");
    write(ignored + "/a/twin.json");
    write(ignored + "/b/twin.json");
    write(".hidden-build/deep/hidden-result.json");
    write("local-build/deep/local-result.json");
    write(ignored + "/reviews/Checks.Case.JSON");
    write("deep/Normal.Case.JSON");
    for (const dir of ["node_modules", ".git", ignored + "/node_modules", ignored + "/.git"]) {
        write(dir + "/never-index.json");
    }
    // Windows 允许 [] / {} / !，但不允许 * / ?；POSIX 上把这两种也验上。
    const globNames = ["Checks[1].json", "Checks{a,b}.json", "!Checks[2].json"];
    if (process.platform !== "win32") { globNames.push("Checks*.json", "Checks?.json"); }
    for (const name of globNames) { write(ignored + "/glob/" + name); }
    for (const name of ["Checks1.json", "Checksa.json", "Checksb.json", "!Checks2.json", "ChecksX.json"]) {
        write(ignored + "/glob/" + name);
    }

    const exact = await findPathCandidates(root, "exact.js", [deepKnown]);
    check("照写的路径就在：只回它一个，不查同名忽略产物", same(exact, ["exact.js"]), JSON.stringify(exact));
    const knownFirst = await findPathCandidates(root, "pick.js", [deepKnown]);
    check("knownFiles 先认，不扩大到普通或忽略同名文件", same(knownFirst, ["deep/pick.js"]), JSON.stringify(knownFirst));
    const knownTwins = await findPathCandidates(root, "pick.js", [deepKnown, path.join(root, "deep2/pick.js")]);
    check("knownFiles 同名多份也全回给界面选", same(knownTwins, ["deep/pick.js", "deep2/pick.js"]));
    const untouched = await findPathCandidates(root, "pick.js", []);
    check("普通候选已有同名文件：全部返回，但不扩大到忽略目录", same(untouched, ["deep/pick.js", "deep2/pick.js"]), JSON.stringify(untouched));
    check("node_modules 里碰过的文件仍优先", same(await findPathCandidates(root, "known-in-modules.js", [inModules]), ["node_modules/known-in-modules.js"]));
    check("没碰过的 node_modules 文件不列", same(await findPathCandidates(root, "known-in-modules.js"), []));
    check("外部 knownFiles 不列为候选", same(await findPathCandidates(root, "outside-only.js", [knownOutside]), []));
    check("删除的 knownFiles 不挡普通候选", same(await findPathCandidates(root, "deleted-twin.js", [goneKnown]), ["other/deleted-twin.js"]));
    check("普通清单唯一同名文件", same(await findPathCandidates(root, "only-here.js"), ["deep/nested/only-here.js"]));
    check("完全没有命中回空数组", same(await findPathCandidates(root, "nobody-has-this.js"), []));

    const names = await findFileNames(root, "", 1000);
    check("普通文件搜索仍遵守 .gitignore / .ignore", !names.slow && !names.files.some((rel) => rel.startsWith(ignored + "/") || rel.startsWith("local-build/") || rel.startsWith(".hidden-build/")));
    const contents = await findFileContents(root, "忽略产物独有文字");
    check("普通内容搜索不扩大到忽略产物", !contents.slow && contents.hits.length === 0);
    const ignoredHit = await findPathCandidates(root, "reviews/Checks.tmo.final02.json", []);
    check("bash 生成、.gitignore 忽略、未登记：短文件链接能定向找到", same(ignoredHit, [artifact]), JSON.stringify(ignoredHit));
    check("findListedFile 共享定向解析，不退回普通清单", await findListedFile(root, "reviews/Checks.tmo.final02.json") === artifact);
    check("选好的完整候选相对路径能直接解析", await findListedFile(root, ignoredHit[0]) === artifact);
    check(".ignore 产物也能定向找到", same(await findPathCandidates(root, "local-result.json"), ["local-build/deep/local-result.json"]));
    check("隐藏且被 ignore 的目录产物能找到", same(await findPathCandidates(root, "hidden-result.json"), [".hidden-build/deep/hidden-result.json"]));
    const twins = await findPathCandidates(root, "reviews/twin.json");
    check("忽略目录同名歧义：多个候选供界面选", same(twins, [ignored + "/a/twin.json", ignored + "/b/twin.json"]), JSON.stringify(twins));
    check("findListedFile 不静默打开歧义候选", await findListedFile(root, "twin.json") === undefined);
    check("定向兜底仍跳过根目录及深层 .git / node_modules", same(await findPathCandidates(root, "never-index.json"), []));
    for (const name of globNames) {
        const hits = await findPathCandidates(root, "reviews/" + name);
        check("glob 字符按字面匹配 " + name, same(hits, [ignored + "/glob/" + name]), JSON.stringify(hits));
    }
    const folded = await findPathCandidates(root, "reviews/checks.case.json");
    check("定向 basename 按 pathCaseKey 的平台大小写规则匹配", same(folded, process.platform === "win32" ? [ignored + "/reviews/Checks.Case.JSON"] : []), JSON.stringify(folded));
    const normalFolded = await findPathCandidates(root, "normal.case.json");
    check("普通候选 basename 使用同一大小写规则", same(normalFolded, process.platform === "win32" ? ["deep/Normal.Case.JSON"] : []));
    const knownFolded = await findPathCandidates(root, "PICK.JS", [deepKnown, deepKnown.toUpperCase()]);
    check("knownFiles 大小写兼容且去重", same(knownFolded, process.platform === "win32" ? ["deep/pick.js"] : []));

    check("新建前无候选", same(await findPathCandidates(root, "new-after-miss.json"), []));
    write("late/reviews/new-after-miss.json");
    check("新建后立刻发现，不缓存定向未命中", same(await findPathCandidates(root, "new-after-miss.json"), ["late/reviews/new-after-miss.json"]));
    write("late/another/new-after-miss.json");
    check("命中后再增加同名文件，也能立刻发现歧义", (await findPathCandidates(root, "new-after-miss.json")).length === 2);
    write("deep/new-normal-after-miss.json");
    check("普通清单缓存尚未刷新，新产物也能通过定向查询发现", same(await findPathCandidates(root, "new-normal-after-miss.json"), ["deep/new-normal-after-miss.json"]));

    // 直接调用真实服务的解析链，不开端口、不启动会话，核对找到的候选确实能打开和仍有边界。
    let known = [];
    const server = new PiChatWebServer(path.resolve(__dirname, "..", "media"), {
        resolveSessionDir: () => root,
        knownSessionFiles: () => known,
    }, { log() {} });
    const resolve = (want, kind = "文件") => server.resolveSessionPath("test", want, kind);
    const resolved = await resolve("reviews/Checks.tmo.final02.json");
    check("resolveSessionPath 能打开短链接找到的忽略产物", resolved.ok && pathCaseKey(resolved.real) === pathCaseKey(fs.realpathSync(path.join(root, artifact))), JSON.stringify(resolved));
    const ambiguous = await resolve("twin.json");
    check("解析链不静默选歧义产物", !ambiguous.ok);
    const absoluteOutside = await resolve(knownOutside);
    check("已有绝对路径指向会话外仍是 403", !absoluteOutside.ok && absoluteOutside.status === 403);
    const relativeOutside = await resolve(path.relative(root, knownOutside));
    check(".. 越界仍是 403", !relativeOutside.ok && relativeOutside.status === 403);
    known = [knownOutside];
    const outsideKnown = await resolve("outside-only.js");
    check("knownFiles 越界仍是 403", !outsideKnown.ok && outsideKnown.status === 403);
    known = [];
    fs.symlinkSync(outsideRoot, path.join(root, "outside-dir"), process.platform === "win32" ? "junction" : "dir");
    const symlinkOutside = await resolve("outside-dir/outside-only.js");
    check("目录软链接指向会话外仍是 403", !symlinkOutside.ok && symlinkOutside.status === 403);
    const symlinkDir = await resolve("outside-dir", "目录");
    check("目录解析沿用软链接 403", !symlinkDir.ok && symlinkDir.status === 403);
    check("定向查找不跟随目录软链接", same(await findPathCandidates(root, "outside-only.js"), []));

    const slow = isolatedSearch({ spawn: missingRg });
    const slowHit = await slow.targeted(root, "Checks.tmo.final02.json");
    check("没有 rg 的定向遍历也能找到忽略产物", slowHit.slow && !slowHit.truncated && same(slowHit.files, [artifact]), JSON.stringify(slowHit));
    check("没有 rg 也跳过 .git / node_modules 和目录软链接", (await slow.targeted(root, "never-index.json")).files.length === 0 && (await slow.targeted(root, "outside-only.js")).files.length === 0);
    check("没有 rg 也按 glob 字符的字面匹配", same((await slow.targeted(root, "Checks[1].json")).files, [ignored + "/glob/Checks[1].json"]));
    check("没有 rg 也使用 Windows basename 大小写规则", same((await slow.targeted(root, "checks.case.json")).files, process.platform === "win32" ? [ignored + "/reviews/Checks.Case.JSON"] : []));

    for (let i = 0; i < 205; i++) { write(ignored + "/many/" + i + "/bounded.json"); }
    const capped = await findPathCandidates(root, "bounded.json");
    check("rg 定向查询限制候选数量，但歧义仍回多个", capped.length > 1 && capped.length <= 200, capped.length);
    const slowCapped = await slow.targeted(root, "bounded.json");
    check("没有 rg 的定向遍历同样限量并标记截断", slowCapped.slow && slowCapped.truncated && slowCapped.files.length === 200, slowCapped.files.length);

    // 确定性时间预算：第一份候选之后模拟超时，不用铺海量文件或实际等四秒。
    let clock = 0;
    const budgetFs = { ...fs, promises: { ...fs.promises, opendir: async () => ({
        async *[Symbol.asyncIterator]() {
            yield { name: "budget.json", isDirectory: () => false, isFile: () => true };
            clock = 4001;
            yield { name: "budget2.json", isDirectory: () => false, isFile: () => true };
        },
    }) } };
    const budgeted = isolatedSearch({ spawn: missingRg, fs: budgetFs, Date: { now: () => clock } });
    const stopped = await budgeted.targeted(root, "budget.json");
    check("没有 rg 的遍历超时保留截断状态", stopped.slow && stopped.truncated && stopped.files.length === 1);
    clock = 0;
    check("遍历截断后的一份结果不冒充唯一候选", (await budgeted.findPathCandidates(root, "budget.json")).length === 0);
    const entryBudgeted = isolatedSearch({
        spawn: missingRg, Date: { now: () => 0 },
        fs: { ...fs, promises: { ...fs.promises, opendir: async () => ({
            async *[Symbol.asyncIterator]() {
                for (let i = 0; i < 400002; i++) {
                    yield { name: "unrelated.json", isDirectory: () => false, isFile: () => true };
                }
            },
        }) } },
    });
    const exhausted = await entryBudgeted.targeted(root, "never-matches.json");
    check("没有 rg、没有命中也有遍历项数预算和截断状态", exhausted.slow && exhausted.truncated && exhausted.files.length === 0);

    let spawnCount = 0;
    let targetedArgs;
    const timedRg = isolatedSearch({
        setTimeout: (fn) => setTimeout(fn, 20),
        spawn: (_exe, args) => {
            spawnCount++;
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stdout.setEncoding = () => {};
            child.kill = () => { setImmediate(() => child.emit("close", 0)); };
            const isTargeted = args.includes("--no-ignore");
            if (isTargeted) { targetedArgs = args; }
            setImmediate(() => {
                if (isTargeted) { child.stdout.emit("data", ignored + "/glob/Checks[1].json\n"); }
                else { child.emit("close", 0); }
            });
            return child;
        },
    });
    const timed = await timedRg.findPathCandidates(root, "missing/Checks[1].json");
    check("rg 超时只收到一份也不能冒充唯一候选", timed.length === 0 && spawnCount === 2);
    check("rg 兜底按精确 glob 定向、覆盖 ignore、保留排除目录", targetedArgs.includes("**/Checks\\[1\\].json") && targetedArgs.includes("!**/.git/**") && targetedArgs.includes("!**/node_modules/**"), JSON.stringify(targetedArgs));

    console.log("\n点链接挑文件：" + checked + " 条，" + (bad === 0 ? "都对上了。" : bad + " 条不对。"));
    process.exitCode = bad === 0 ? 0 : 1;
})().catch((err) => {
    console.error("跑炸了：" + (err && err.stack ? err.stack : String(err)));
    process.exitCode = 1;
}).finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
});
