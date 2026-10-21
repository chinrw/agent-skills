# Claude session: #3778 与后续文件系统修复

核对日期：2026-09-14。来源是 Claude Code session
`4e9f529a-3830-457a-9ed1-7e1d3421bb05`，标题为
“#3778 还有额外的ramfs 修改”。本记录补充
[原 conversation 总结](conversation-summary.md)，用于解释 workflow 中的约束。
这里的历史结果不构成当前 checkout 的新运行，也不授权执行旧命令。
当前 skill 用这些经验准备 [复现 handoff](reproduction-handoff.md)，
由接收模型执行实验并回传证据。

## 来源与核对范围

原始 JSONL：
`/home/chin39/.claude/projects/-home-chin39-Documents-play-specula-profile/4e9f529a-3830-457a-9ed1-7e1d3421bb05.jsonl`。
本次快照覆盖 2026-09-02 至 2026-09-14，9097 条记录；同时索引并保存了
42 份关联 subagent transcript。以下 L 编号指这份主 transcript 的原始行号。

快照 SHA-256：
`e435f6bc3d92afd1c866bf27aad440b15d1c687441cc50825b99be9720c1fbe2`。
只读收集、时间线及子任务索引位于本机
`/tmp/aster-debug-claude-session-20260914-hpdzkgjf/`。
使用本 skill 不依赖该临时目录；后续运行重新确认源码和环境。
下文 specula-profile 的相对路径以
`/home/chin39/Documents/play/specula-profile/` 为根目录。

核对沿着原始请求、回答、工具结果和落盘日志进行，保留 compaction 前的
记录。开头的 AST-08、AST-09 等旁支只用于确认范围，没有据此扩展本 skill
更新为那些问题的修复任务。早期建议与后续实验冲突时，以可追溯的纠正为准。

## 被后续证据纠正的判断

| 历史判断 | 后续证据与采用的结论 |
|---|---|
| 原地 limit 只会多一次零长度读；ext2 有先例，因此安全（L2869、L3176） | append 可以插在两次 read_at 之间，使下一次读非零；L4519 明确撤回原判断，L4793 给出 guest 反例。检查调用后的可观察状态，不能把现有实现当作正确性证明 |
| readv 竞态窗口太小，不值得写回归（L4519） | L4793 的纯 syscall 测试在错误内核上出现 294/20000 次分裂。先测区分力，不凭直觉放弃测试 |
| 4 CPU、20000 轮足以稳定检测 | L6851 同一错误内核和二进制一次 0、一次 201；有 CPU 放置检查的变体两次为 209、201。轮数不能代替有效的并发前提 |
| 连续创建两个或八个线程保证跨 CPU | 这是过强的调度假设；后续代码保留实际 CPU 检查。线程数提供机会，getcpu 只是快照，不能当作 affinity |
| duplicate-OSTD 来自复制的缓存（L3865） | L3922 改正根因：手动编译 cargo-osdk 时缺少编译期 OSDK_LOCAL_DEV=1。清缓存不是这次故障的修复 |
| 185 个 summary 都是测试 | L6398 更正为 184 个 test summary 加一条 exfat Media summary。摘要输出不能当断言计数 |

L7866 关于尾部零填充与安全性的判断，也不能作为通用结论导入。
已观察到的尾部覆盖足以证明接口错误；数据来源、冷页、mmap、权限边界和
消费者后果需要各自的证据，不能由一个返回值或零填充样本代替。

## 三个 read 问题需要不同的对照

| 性质 | 目标失败对照 | 为什么不能混用 |
|---|---|---|
| EOF 后缓冲区不被修改 | 原始 ramfs/exfat 加最终 EOF 测试 | 原代码返回长度已经正确，只检查返回值看不到尾部覆盖 |
| iovec 按顺序填充 | 仅把 clone 改成原地 limit，保留锁修复 | 8192 字节的第一项大于那一页缓存，原始整页复制仍留下空间，原始版本可以通过此 guard 测试 |
| 返回长度不包含未复制字节 | 仅撤销 ramfs 取 size 到 copy 的锁保护 | 保留 EOF/clone 修复，才能把失败归到尺寸快照竞争 |

2026-09-11 的八 writer 工作区快照有独立的 guest 证据（L8156）：

| 源码快照 | SMP | 观察 |
|---|---:|---|
| `d1c0278702f17d02ead5d66f573bb10dafed6369` | 4 | fs suite 184 个 test summary 通过；split 0/20000；truncate case 通过 |
| `254c19b7608fa30479fb3d7f588ff7a42ce533a4` | 4 | in-place mutation：split 1767/20000，目标 case 失败 |
| `a3a0ae1375fbcab63636cf59d404e15312d9a4c2` | 4 | no-lock mutation：truncate case 失败，split 0/20000 |

原始 guest 日志保存在 specula-profile 的
`reports/ast-validation-2026-09-02/logs/wip-2026-09-11/`，分别为
`guest-WIP.log`、`guest-WIPinplace.log`、`guest-WIPnolock.log`。
对应 `.out` 也保留了构建、运行退出码和目标摘要。失败套件会提前停止，
其 148/149 个 summary 不能报成完整套件通过。

L8225 又报告了 `f5ececb71a58d091af5b4c2366a709f67bd66937` 的正常 guest
运行，包含 start_writers 和 preadv 测试改名；这是后一次源码版本。
不能把前一次 mutation 的次数自动归到这个版本或最终 `d007cbb623`。
宿主 Linux 的 tmpfs/btrfs 结果也不能改称为 Linux ext2/exfat 对照。

## 锁与进度：源码审查具体要追到哪里

- L7240、L7287：裸 `_` 接收 guard 会立刻释放；guard 若留在取 size 的
  内层 block，copy 前仍有窗口。修复要绑定同一个 guard，并通过它调用 read，
  避免持锁后再次 lock。短注释说明这个范围为何不能缩小。
- L1852：照搬 virtiofs 的 early return 会跳过 ramfs/exfat 后面的 atime
  更新。相似模式要核对外围副作用，不能只比较复制代码。
- L1148 对历史大补丁的审查发现：让 Vmo 的部分 fault 返回 Ok，会改变
  所有调用方的计数契约；只修改部分文件系统会留下错误的 size 发布。
  拷入尚未提交的 BIO、后来丢弃的页前缀，也可能已推进 reader cursor。
  区分 copied、staged、committed、reported，不能无条件用 cursor 差值代替进度。
- L8670：exfat copy 的 backend 要取 inner.read；upread 与普通 read 的
  兼容性来自 RwMutex 实现。resize 在 upgrade 后还可能因冷的非对齐尾页
  进入 fill_zeros 和 backend，必须另外审查，不能由 warm copy 的成功推出。

这些线索已与当前树的 `RwMutex::try_read/try_upread`、
`PageCache::resize` 和 exfat 写分支核对。AST-15 的历史 syscall 复现是
session 引用的既有证据，本次没有重新执行。

## exfat 后续修复：从无效夹具到有效 oracle

AST-11 的写锁修复最初叠在 #3778 上，后来确认能独立落到 main。
代码依赖由实际 diff/cherry-pick 验证，不能从分支祖先关系直接推断。
用户在 L8674 选择将相邻的 AST-15 冷尾页死锁分开处理。

AST-11 在后一次 01b campaign 中也叫 MC-3，和早期 AST-05 的 MC-3
不是同一个 finding。关联时使用 run、target、finding ID；仅按 MC-3 去重
会把两个不同的读/写问题合并。这是 Specula intake 保留来源身份的实际理由。

exfat-write-race 的 README 记录了两个被替换的测试设计：

- 预先填满 8 KiB：两个 writer 不需要扩展文件，绕开了目标 resize 路径。
- checker 兼任短 writer：两方 barrier 的最后到达者可能先写完，另一个
  writer 才被唤醒，竞争不足。

最终夹具每轮先清空文件，以三方 barrier 放行两个独立 writer（8 KiB 和
4 KiB），等待两次写完成，再检查 st_size、返回长度和 sentinel。
它检查两个 writer 是否跨 CPU；checker 在哪里不是这个竞争的前提。
停止时要放行 start barrier，join 后才销毁 barrier 和关闭 fd。

9 月 14 日 V2 的历史结果：

| 角色 | 运行源码 | 观察 |
|---|---|---|
| fixed SMP=4 | `dd7e4d4ee` | /tmp、/ext2、/exfat 均 0/2000；180 个 test summary 通过 |
| test-only SMP=4 | `83d4b85f4` | /exfat 93/2000 坏轮；V1 同一角色为 65/2000 |
| fixed SMP=1 | `dd7e4d4ee` | 目标 case 明确 SKIP；其余套件通过 |

日志目录：specula-profile 的
`reports/ast-validation-2026-09-02/exfat-write-race/fix/logs/v2/`。
V1 tip 因 QEMU 端口冲突未进入测试；V1 失败记录与 V2 都保留。
`exfat-V2-clippy.log` 有两次 clippy 完成记录，随后因缺少 cargo udeps
退出失败，不能称整个 check 脚本通过。Linux 宿主记录只覆盖实际存在的目录，
这些证据不足以补齐本 skill 要求的所有 Linux 文件系统矩阵。

最终测试提交 reword 为 `3ece5470276d659422f9e88bb58bf2855c279814`。
本次核对它和日志中的 `dd7e4d4eecce3444f994e638759f6f437c60f333`
tree 都为 `5d5aa7f339f1081c60b63badb31ac331bc775fad`。
保留这个映射，不能直接改写原始日志中的 source ID。

## 提交、文案与交接

- 早期回答提过多种切分，最终约束是按独立机制组织系列，测试紧跟对应修复。
  用户要求合并 EOF 与 preadv 测试后，保留两个不同的 bisect 事实即可，
  不应再把“一种性质必须独占一个测试 commit”写成规则。
- 注释留约束和非显然的参数目的，调查经过、测量归属和未覆盖问题放进
  commit body 或案例。commit 格式遵循当前指令，不把历史段落格式永久化。
- 测试改名要更新 runner selector 和文案；rebase/reword 要更新 patch、
  旧新 OID 映射、commit 序号和回复草稿，同时保留实际受测身份。
- 历史 scratch worktree 或分支名不是当前所有权证明。查看 checkout、
  未提交文件、其他任务占用及备份后，才执行本轮已获授权的整理。
  本次更新只读这些位置，没有执行旧 session 的 reset、删除或 push 命令。
