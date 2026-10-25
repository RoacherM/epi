# Pi extension 工作区接入 probe

**Throwaway，不是 LayerFS 实现，也不是可安装使用的产品扩展。**

问题：不修改 Pi 内核，一个普通 extension 能否承接工作区工具路由、checkpoint 与会话归因？

```bash
node scripts/probes/layerfs-extension/run.mjs
```

需要仓库已有 Node/Pi 依赖。无需 Docker、LayerFS、模型密钥或联网；打印 JSON 检查结果，断言失败以非零退出。临时 HOME/EPI_HOME、项目目录和 guard 日志运行结束后删除。

## 组成

- `extension.mjs`：只依赖 Pi 公共导出；注入 backend，覆盖 `read/write/edit/bash`，路由 `user_bash`，通过 `appendEntry` 记 checkpoint，监听 shutdown。不 import Epi 实现。
- `run.mjs`：真实 Pi AgentSession + 本仓库的脚本化 faux provider + 内存文件 backend。通过正常 prompt/tool pipeline 执行预定调用，不调用真实模型。
- shell 是固定几个测试命令的模拟器，绝不执行输入的真实命令。network guard 拒绝并记录主线程 fetch/TCP；此探针不启动子进程。

## 实测结果

12 项断言组通过（依赖版本由脚本从 package.json 打印）：

1. 注册扩展命令、覆盖内置工具，每个工具名只有一个有效工具；read 读假工作区而非磁盘原文件。
2. 无变化的 write 不虚构 checkpoint。
3. 同一响应的 write + 多位置 edit 正确执行；完整 tool/checkpoint 串行化，回执携带对应 toolCallId。
4. 假执行器尚未结束时，Pi 已向观察者发送输出更新。
5. shell 非零退出仍是工具错误，但它产生的文件变化可以保存，不当作“没有改动”。
6. tool_call 阻断和词法路径越界拒绝有效。
7. 写文件成功而 checkpoint 失败，工具显式报错，不创建虚假回执；写入仍然存在。
8. session.abort 将 AbortSignal 传到假执行器。
9. `user_bash` 的真实事件和 executeBash 路由有效；同时复现下一次 checkpoint 混入先前未保存写入。
10. checkpoint entry 不进入模型上下文；会话历史分支变化只影响可见 entry，不回退 backend。
11. 新建不加载扩展的 Session 使用本机工具，不继承父会话扩展。
12. 显式发送两次 shutdown 只关闭 backend 一次；磁盘源文件未修改、guard 未记录网络尝试。

## 探针实际揭示的设计问题

**“一个工具完成后 commit，再记 toolCallId”并不是完整归因协议。**

测试先让 write 创建 `pending.txt`，然后人为使 checkpoint 失败。之后 `user_bash` 创建 `user.txt`。下一次成功 checkpoint 同时包含两份文件，但最简扩展只记录了后一次调用来源。

正式实现必须在 checkpoint 失败后进入待恢复状态，阻止继续修改，或显式保存所有 pending 修改来源并一起归因。不能把“工具失败”误认为文件已经回滚，也不能把后一张回执冒充全部变更的唯一作者。本探针故意保留这个最简行为，用断言证明问题；它不是生产参考实现。

另一条明确结论：会话历史和文件历史是两种状态，Pi 的分支导航不会替扩展同步工作区。需要自行定义 fork/resume/rewind 策略。

## 没有验证什么

- 真正的 LayerFS SDK、native addon、Store、FUSE、Docker 或崩溃持久性。
- 容器内进程树终止、TERM→KILL、超时、二进制和图片传输、symlink/hardlink。
- Epi Manifest 安装加载、真正的 Task worker 子进程、Review/Trace TUI 接入。
- 重启恢复、磁盘回执持久性、加载失败与未知结果恢复。
- 自动触发的宿主 shutdown/reload 流程：这里只显式派发事件验证 handler，不能据此承诺退出时一定回收。
- 通用文件安全沙箱：fake backend 的词法路径检查不是软链接或容器权限实现。

## 对“做成 pi-extension”的结论

**单会话工具路由与检查点逻辑可以放在独立 Pi extension 中，Pi 内核不需要改。**

但独立扩展不会自动接管 Epi 的 Task、Review 或 Trace：

- 当前 worker 自己装配扩展，必须显式接入；不能只在父会话装包。
- Review 当前数据来源是写死的枚举；需要新的来源接入点，或扩展先提供自己的 `/layerfs` 子命令。不能抢注册 `/review`，Epi 会拒绝重名命令。
- 自定义 checkpoint entry 可以先持久化，但专门的 Trace 展示和跳转仍需 Epi 消费它。

下一步优先验证真实 LayerFS 的取消/输出/二进制路径，再决定采用独立命名工具还是透明覆盖。不要因本 probe 通过而宣布 LayerFS runtime 已可用。

完整调研见 [research-layerfs.md](../../../docs/notes/research-layerfs.md)。
