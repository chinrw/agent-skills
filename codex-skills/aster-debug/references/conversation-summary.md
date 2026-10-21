# PR #3778 调试案例与 skill 设计依据

整理日期：2026-09-12。此文记录本次 conversation 的经验和证据边界。
历史运行结果属于各自的源码、二进制和环境；使用 skill 时重新确认目标版本。
文末的本机路径用于追溯案例，skill 的执行不依赖这些临时目录。

2026-09-14 又核对了 Claude Code 的完整 session 与关联日志。
[后续案例记录](claude-session-lessons.md) 补充了独立 mutation、八 writer
工作区版本的 guest 验证，以及 exfat 写侧的夹具和 backend 锁问题。
下文仍保留本 conversation 当时实际掌握的证据，不把两次收集混成一次运行。

后续需求把完整修复流程明确为：reproducer 和正式 regression 都要验证
Asterinas 修复前失败、修复后通过，以及 Linux 同 syscall 场景通过。
下面的历史记录不表示旧 PR 已完成这个更完整的矩阵；缺口仍按原记录保留。

2026-09-16 起，当前 skill 负责源码分析、修复与测试编写，并把复现和运行验证
交给其他模型执行。[handoff 要求](reproduction-handoff.md) 定义交接材料及
证据回传；下面的历史流程不要求当前模型重新运行这些实验。

## 目标与范围如何确定

- 原始目标是修复 ramfs/exfat 的 EOF 读取，并让当前 PR 能以清楚的范围合并。
- 用户要求补跑因 Docker 权限而未运行的测试，并指定了
  `asterinas/dev:0.18.1-20260901`。
- 收到额外 review findings 后，用户明确改为先分类，暂停新的复现。
  ext2、fallocate 和部分拷贝错误因此作为独立问题记录。
- 用户后来分别授权测试整理、增加锁修复提交和 amend。
  这些授权没有包含 push、GitHub 回复或修改 PR 描述。

可复用原则：先确定本轮要求的是解释、分类、复现、修复还是提交整理。
阶段变化来自用户意图和已有证据；debug skill 本身不扩大授权范围。

## 三个容易混淆的失效模式

| 问题 | 机制 | 本系列处理 |
|---|---|---|
| EOF 后的缓冲区被写入 | 文件逻辑大小小于按页分配的缓存容量，读取只受 writer 容量约束 | ramfs/exfat 按逻辑 EOF 限制复制长度 |
| 短读后继续下一个 iovec | 原地 `writer.limit()` 缩小结束边界，复制后 `has_avail()` 为 false | clone 上 limit，原 writer 只 skip 实际长度 |
| 返回计数包含未复制的字节 | ramfs 先读 size，稍后才锁缓存；中间 truncate 缩小 VMO | 提前持有 page-cache 锁，覆盖取 size 和复制 |

`VmWriter::limit()` 修改结束边界；`skip()` 推进游标；
`clone_exclusive()` 创建独占借用的 writer 视图，不复制缓冲区内容。
`do_sys_readv` 和 `do_sys_preadv` 在调用返回后检查 `writer.has_avail()`。
因此，writer 的剩余空间属于调用者观察的接口行为，不能只检查返回值。

当前实现位置可从这些路径查找：

- `ostd/src/mm/io/mod.rs`：`VmWriter`、`limit`、`skip`、`clone_exclusive`。
- `kernel/core/src/syscall/preadv.rs`：向量遍历和短读停止条件。
- `kernel/core/src/fs/fs_impls/ramfs/fs.rs`：`read_at`、`write_at`、`resize`。
- `kernel/core/src/fs/fs_impls/exfat/inode.rs`：`inner` 的可升级读锁。
- `kernel/core/src/fs/fs_impls/ext2/inode/file.rs`：读锁与原地 `limit`。

## 为什么需要分别看三个文件系统

| 文件系统 | 取 size 到复制之间的锁 | writer 边界问题 |
|---|---|---|
| ramfs 修复前 | metadata 锁与缓存锁分离，存在可插入 truncate 的窗口 | 本系列修复 EOF 范围并保留 clone |
| ramfs 修复后 | 先锁缓存，再读 size，复制完成后释放 | clone、limit、skip |
| exfat | `inner.upread()` 原本就覆盖 size 和复制；resize 需要同一个锁 | EOF 修复仍需保留 clone |
| ext2 | `inner.read().read_at(...)` 的 guard 覆盖整个内部调用，resize 取写锁 | buffered 和 direct 路径仍有原地 limit |

这里关于锁的结论针对“本次读取的取 size 与复制之间被 truncate 插入”。
它不表示某个文件系统不存在其他并发或错误恢复问题。
单次 `read_at` 的锁也不等于整个 `preadv` 都被锁住。

## 回归测试如何对应机制

### EOF 检查

- 在 ramfs/ext2/exfat 上创建小文件，检查 read/pread 的返回长度和缓冲区尾部。
- 用 `0xAA` 初始化目标缓冲区，验证返回范围之外没有被修改。
- 原始 ramfs/exfat 的按页多拷贝会使这些检查失败。

### preadv 与并发 append

- 文件内容在 `hi` 与 `hi!` 之间变化。
- 第一个 iovec 为 8192 字节，第二个为 1 字节。
- 正常情况下，所有实际读取的数据都属于第一个 iovec。
- 如果读到 `hi` 后 append 发生，而内核错误地认为第一个 iovec 已填满，
  `!` 会进入第二个缓冲区。

第一个缓冲区大于当时的一页缓存是有意选择：原始按页多拷贝也填不满它，
所以这个向量测试在未修复的原始代码上可以通过；它专门拦住“只做原地 limit”
这一错误简化。它与 EOF 检查不重复。

| 对照版本 | EOF 检查 | 向量检查所区分的行为 |
|---|---|---|
| 原始 ramfs/exfat | 可观察到缓冲区尾部被覆盖 | 原始整页复制仍给第一项留下空间 |
| 原地 limit 的替代实现 | 尾部越界复制被限制 | 短读可能被误判为填满，竞态用例可失败 |
| clone + limit + skip | 尾部受保护 | 调用者保留正确剩余空间，在短读后停止 |

这是测试设计的因果关系；竞态运行是否捕获窗口仍需看对应日志。
不要要求每个测试在同一个“撤销全部修复”的版本上都失败。

### read 与 truncate

- reader 反复 pread，writer 交替把文件截成 0 和写成 8 KiB 的 `x`。
- 只检查 `[0, ret)`：其中留下的 sentinel 表示内核计数了未复制的字节。
- 返回 0 或短读本身允许；测试针对计数与复制不一致。
- 原始 200000 轮 stress 的“约 4%”观测不能归到后来的 20000 轮测试上。

后来两个竞态用例都改为八个 writer，等待 CPU 信息发布，检查是否至少有
一个 writer 位于其他 CPU，并在单 CPU 或全部同 CPU 时明确 SKIP。
八个 writer 提供更多机会，不能保证命中竞态或固定的 CPU 分布。
`getcpu()` 是快照，这里的检查依赖所检版本的 Asterinas 不迁移线程。

两个测试保留各自的 oracle，通过 `start_writers()` / `stop_writers()`
缩短测试主体。停止和 join 先于关闭 fd，SKIP 分支也遵守这个顺序。

## Review findings 的分类经验

- 原始目标中的 EOF 和 ramfs 锁窗口，直接影响本系列需要实现的行为。
- ext2 的原地 limit、ramfs fallocate 并发问题、mid-copy EFAULT 等，
  按本次明确限定的 PR 范围作为既有的独立问题。
- PageCache helper 抽取属于接口设计建议，需要评估各调用点的差异。
- payload 断言、issue 引用、接口文档和更强的调度覆盖具有改进价值，
  与“这条修改引入了可触发回归”是不同结论。
- 大缓冲区和重复拷贝是否过度，需要结合 oracle 和实测成本判断。
  不能先删掉让测试具有区分力的尺寸，再以运行更快作为唯一依据。

分类记录应同时保留来源、证据程度和范围。既有问题不等于无效问题；
真实问题也不自动成为当前 PR 的新增工作。

## 实际运行过什么

### focused guest 测试

在指定镜像、QEMU/KVM、2 vCPU 下，早期版本以及合并测试后的版本各有
focused guest 运行记录。合并后的那轮是 25 个断言通过、0 个失败，
包含 EOF、向量读竞态和 truncate 竞态；不是完整 fs suite。

后续八 writer 和函数拆分版本做过两个 C 程序的
`-Wall -Werror -D__asterinas__` 静态链接编译，退出码为 0。
该编译结果不等于八 writer 版本的 guest 运行结果。

Claude session 另有 2026-09-11 工作区快照的 guest 运行和两个 mutation
对照，详见后续案例记录；它们也不能直接改标为最终 `d007cbb623` 的运行。

### ext2 独立复现

历史独立 probe 复用了源码构建记录为
`89b3b6149891a2b5787d99d054113cf3655dd5f3` 的内核。
其 SHA-256 为：

```text
fc1550850bd0cee090694075a9990a02f29ef34bc09a2c65aac30b7d0a31c7f8
```

probe 的工作目录名称含 `690a8651f`；该名称不是实际内核构建身份。
QEMU 命令和两个 manifest 中的内核 hash 才建立了对应关系。

4 vCPU、20000 轮 buffered preadv + append 的结果：

| 环境 | 异常次数 |
|---|---:|
| Asterinas ext2 | 343 |
| Asterinas ramfs | 0 |
| Linux tmpfs | 0 |

```text
sample round=3462 ret=3 first=68,69,aa second=21
RESULT case=readv_append rounds=20000 anomalies=343 churns=10711 short=11220 extended=8780
CASE_RESULT=readv_append-ext2:1
```

`68 69` 是 `hi`，`aa` 是未覆盖的 sentinel，`21` 是 `!`。
这证明历史运行确实出现了错误的 iovec 布局。
Linux 对照使用 tmpfs，不能称为“Linux ext2 对照”。

此证据只覆盖 buffered preadv。ext2 的 `O_DIRECT` 路径有源码层面的同类
写法，但未在该 probe 中运行；也没有本 conversation 中 ext2 修复后转绿
的记录。当前 PR 的正式向量竞态用例仍只针对 ramfs。

### 验证脚本自身的问题

`series-run.sh` 曾打印非零测试状态，却在清理和收尾后以 0 退出。
修复保留了测试失败或超时的状态，仅在测试成功时采用 cleanup 失败状态。
七个受控场景验证了这个行为：

```text
success: exit=0, cleanup=True
c1_failure: exit=1, cleanup=False
format_failure: exit=1, cleanup=False
test_failure: exit=2, cleanup=True
timeout: exit=124, cleanup=True
cleanup_failure: exit=7, cleanup=True
test_and_cleanup_failure: exit=2, cleanup=True
```

同一次历史 probe 运行中，QEMU 退出 33，同时 ext2 case 返回 1。
因此，boot/shutdown 成功、runner 成功和 test case 成功必须分别读取。

## 提交与协作留下的经验

- 用四条逻辑提交表达 EOF 修复、EOF/preadv 测试、ramfs 锁修复、truncate 测试。
- 测试代码合并后仍保留两个不同的 bisect 事实：EOF 检查在原始代码上失败，
  向量检查用于区分错误的原地 limit 方案。
- commit message 解释 why；短注释保留约束和测试意图。
- 每次历史整理前保留旧 ref 和未提交文件；之后检查最终 tree、每条提交的
  文件范围、作者签名和执行顺序。
- 使用 range-diff 区分内容变化与 rebase/reword 导致的 ID 变化。
  reflog 中的命令文字本身不足以证明是哪个人或 agent 执行的。

本 task 曾将系列整理到 `38ff5b28765f9d5caeb2048420444a111d52d5a0`，
验证最终 tree 与整理前的工作区一致，并保留备份。
2026-09-12 收集本总结时，checkout 已处于后续版本：

| # | 收集时的 commit | 主题 |
|---|---|---|
| 1 | `042ff520cb34ff579fe5f6b7c8d728a8ae78c8f0` | EOF 范围修复 |
| 2 | `17234066b175a241f781ecd3f2fd9ac45f641855` | EOF/preadv 测试 |
| 3 | `16e1bcaa67dbf8db89a390581a985dba6035084a` | ramfs 读取与 resize 串行化 |
| 4 | `d007cbb623bde58c6692feb6e3257ca1490438fd` | truncate 竞态测试 |

这个表是收集时的身份记录，不是这些新 commit 已通过历史运行的声明。
本 task 没有执行 push、GitHub 回复或 PR 描述修改。

## 案例证据索引

以下路径来自本次机器上的原始记录；临时目录可能被后续清理。

- 指定镜像下的早期 guest 运行及实际内核构建身份：
  `/tmp/asterinas-read-tests-20260901-zlxy9rep/result.json`。
- 合并测试后的 focused 运行：
  `/tmp/asterinas-merge-eof-tests-xxyw6j7r/result.json`。
  它的源码身份还要结合该目录的 `rewrite.json` 与 README 中的合并记录；
  不能把单个 manifest 的旧 HEAD 字段当成最终 amend 后的提交 ID。
- ext2 probe 源码：
  `/tmp/asterinas-followups-690a8651f-917p2w3v/probe.c`，`vectored_read()`。
- ext2 运行原始输出和 QEMU 命令：
  `/tmp/asterinas-followups-690a8651f-917p2w3v/asterinas-initial/guest.log`、
  同目录 `results.json`。
- Linux tmpfs 对照：
  `/tmp/asterinas-followups-690a8651f-917p2w3v/linux-initial/results.json`。
- runner 七个控制场景：
  `/tmp/asterinas-followups-690a8651f-917p2w3v/script-fix/green.log`。
- 八 writer 整理版本的 C 编译：
  `/tmp/asterinas-race-test-cleanup-s9o0j39g/compile.json`。
- 本 task 的四提交改写及 tree 一致性：
  `/tmp/asterinas-series-amend-pw1_ympt/result.json`。

## 从案例提炼出的完成标准

- 分类完成：每个目标 finding 的机制、范围和证据程度都有依据。
- 复现完成：保存了特定二进制和环境上触发目标 oracle 的实际输出。
- 修复验证完成：相关失败机制在受控对照中被消除，验证边界明确。
- 提交整理完成：授权范围内的提交已落地，代码与预期 snapshot 一致。

这些是不同的交付结果。保持这种区分，才能避免“看起来合理”、
“历史上跑过”和“当前版本已验证”在交接时变成同一句话。
