---
title: 一次开源 PR 复盘：没遵守最小改动原则踩的坑
date: 2026-11-25 09:30:00
categories:
  - 踩坑记录
tags:
  - 开源协作
  - PR
  - Go
  - open-code-review
---

最近给 `alibaba/open-code-review` 提了一个 PR（[#1925](https://github.com/alibaba/open-code-review/pull/1925)），用来解决 Issue [#1880](https://github.com/alibaba/open-code-review/issues/1880)：让工作区模式（`ocr review`）支持 `--resume`。最后我的 PR 没有被合并，维护者合并了另一位贡献者的 [#1922](https://github.com/alibaba/open-code-review/pull/1922)。

把两个 PR 的改动和维护者的回复对照看了一遍，核心原因很直接：我没有遵守**最小改动原则**。

## 两个 PR 到底差在哪

Issue #1880 要解决的问题其实很明确：工作区模式评审大改动时如果中途断了，重新跑会把已经评审完的文件再跑一遍，浪费 token，希望能像 range/commit 模式一样用 `--resume` 接着跑。

`#1922` 的做法非常克制：

1. 直接复用现有的 `SourceArtifactSHA256` 和 `ResolvedBase`（HEAD）校验。
2. 只要工作区和 HEAD 没变，就允许恢复，跳过已经完成的文件，只重试没完成的。
3. 只要工作区有任何改动，就直接拒绝恢复，让用户新开一次评审。

整个 PR 的核心生产代码改动不到 40 行。

而我在 `#1925` 里改了 27 个文件（`+1030 / -168`），除了支持工作区恢复之外，还顺手塞进去好几样东西：

- 跳过了 `SourceArtifactSHA256` 校验，改用 `git merge-base --is-ancestor` 判断提交祖先关系，再配合单文件指纹匹配，做成“编辑后也能部分复用”的增量恢复。
- 改了 CLI 入口，不传 `--from`/`--to`/`--commit` 时自动从历史 session 的 manifest 推断目标参数，并加了参数冲突检查。
- 在 `interrupt.go` 里顺手加了一句中断时的提示打印。
- 顺手改了 `.gitignore`，把 `.env` 和 `.scratch/` 加了进去。

## 为什么维护者选了严格模式？

那么问题来了，工作区的文件本来就容易被修改，做成编辑后也能增量复用，体验听起来更好，为什么维护者反而不合？

维护者在 `#1925` 里给的答复很清楚：#1880 的定位就是窄范围的静态工作区恢复，至于“跨改动的增量评审”该怎么设计、交互怎么定、长期怎么维护，团队自己都还在讨论，短期内不打算在一个小需求里直接拍板。

除此之外，还有一个容易忽略的**不变量**问题。

原本 `ValidateResume` 维护的核心前提是：**绝不把两份不同输入上下文的评审结果混在一起**。需要注意的是，`open-code-review` 的 AI Reviewer 会调用 `file_read` 读整个文件甚至关联文件，并不只是盯着单个 patch 看。

如果跳过整包摘要，只靠单文件 patch 指纹决定要不要复用，就会出现漏洞：比如用户删掉了被依赖的另一个文件，或者在当前文件 hunk 下方改了代码，这个文件的 patch 指纹根本没变，但旧的评审评论其实已经过时了。

反观 `#1922`，从头到尾都在维护原有的不变量。后来维护者实测发现“删除已跟踪文件会让 `sourceArtifactSHA256()` 漏检”，作者也只是把 workspace 下的 deleted diff 纳入摘要计算，十几行就修完了，不需要动整个恢复机制的设计。

## 顺手多改出来的三个坑

值得一提的是，回头看 `#1925` 被查出来的 3 个具体问题，全都是在我“顺手多做”的改动里引入的。

### 1. `interrupt.go` 搞挂了 Unix 强退测试

我在 `cmd/opencodereview/interrupt.go` 的信号监听 goroutine 里，顺手在 `cancel()` 前面加了一行打印：

```go
case <-ch:
    fmt.Fprintln(os.Stderr, "[ocr] Interrupted. Saving session checkpoint...")
    cancel()
```

问题在于，如果 `stderr` 管道写满导致阻塞，信号监听协程就会卡死在这行 `fmt.Fprintln` 上，既调不到 `cancel()`，也接不到第二次强退信号。这直接导致已有测试 `TestSecondSignalExitsWithBlockedStderr` 在 macOS/Linux 上超时 30 秒失败。

因为我是在 Windows 上跑的 `make test`，而 `interrupt_test.go` 带了 `//go:build unix` 标签，本地根本没编译到这个测试，提交的时候完全没发现。

### 2. 新加的 `IsAncestor` 吞掉了 Git 错误

为了支持 `HEAD` 往前提交后还能恢复，我在 `review_cmd.go` 里加了个 `IsAncestor` 回调去跑 `git merge-base --is-ancestor`，但实现的时候把所有 `err != nil` 都直接转成了 `false`。仓库的 OCR Bot 直接报了一个 medium bug：万一遇到 git 锁冲突或 I/O 报错，用户看到的提示会变成“当前 HEAD 不是祖先”，完全掩盖了真实错误。

### 3. 精力分散漏了细节

前面花太多精力在增量复用和参数推断上，反而漏掉了两处基础问题：

- 5 种语言的 `pages/src/content/docs/*/tools.md` 里还写着不支持工作区恢复，忘了改。
- `TestWorkspaceReviewResume_E2E` 直接把 `t.TempDir()` 传给 `session.ListSessions`，没用 `filepath.EvalSymlinks` 处理路径，在 macOS 下 `/var` 和 `/private/var` 对不上，导致 E2E 跑不过。

如果一开始老老实实只做最小改动，这三个问题一个都不会碰到。

### 小tips

- **一个 PR 只做一件事**：Issue 要什么就先交付最小闭环。像 CLI 自动推断 `--from`/`--to`/`--commit` 这种改进，如果真的有用，应该单独拆成另一个小 PR 去提，混在一起只会拉高合并门槛。
- **改核心不变量前先在 Issue 里问清楚**：像要不要放宽 `SourceArtifactSHA256` 这种属于设计分歧，先在 Issue 里对齐，别闷头写完 1000 行再让维护者在 PR 里做选择。
- **别“顺手改一下”无关代码**：`.gitignore`、终端提示语这类超出需求的改动，看着省事，实际上都在增加 review 负担和跨平台回归风险。
- **认领后尽早同步进度**：11 号认领之后闷头写了两天，期间没在 Issue 里说思路，等 13 号别人先发了更轻量的 PR 时，我的代码已经写得很重了。早点同步方案或者先开 Draft PR，能省掉很多返工。
