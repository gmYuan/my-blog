# Scheduler 宏观理解 - 从0到1的思维推导

## 第一部分：它在解决什么问题？

### 问题场景

假设你在浏览一个购物网站：
- 你点击了"加入购物车"按钮（**高优先级**：用户直接交互）
- 同时页面在后台计算推荐商品（**低优先级**：不紧急的任务）
- 页面还在处理一个复杂的数据统计（**普通优先级**：重要但不紧急）

**核心矛盾**：JavaScript 是单线程的，一次只能做一件事！

### 没有 Scheduler 会发生什么？

| 场景 | 问题 | 用户感受 |
|------|------|----------|
| 长任务占用主线程 | "计算推荐商品"执行了 500ms | 点击按钮后卡顿 0.5 秒 |
| 按任务到达顺序执行 | 低优先级任务先到，高优先级任务排队 | 点击没反应，体验极差 |
| 无法中断任务 | 一个任务必须执行完才能执行下一个 | 页面卡死、无响应 |

**本质问题**：没有"交通指挥员"来管理这些任务的执行顺序和时间分配。

---

## 第二部分：Scheduler 的整体架构与执行流程

### 2.1 三个核心组件

Scheduler 通过三层设计实现任务调度：

```
┌─────────────────────────────────────────────────────────────┐
│  1️⃣ 任务管理层：两个优先级队列                              │
│                                                             │
│  taskQueue (就绪队列)          timerQueue (延迟队列)         │
│  • 立即可执行的任务             • 延迟执行的任务             │
│  • 按 expirationTime 排序      • 按 startTime 排序         │
│  • 最小堆：最紧急的在堆顶        • 最小堆：最早到的在堆顶     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  2️⃣ 异步调度层：两种触发机制                                │
│                                                             │
│  MessageChannel                setTimeout                   │
│  • 立即任务的异步调度           • 延迟任务的定时唤醒          │
│  • 宏任务，约 1ms 延迟          • 单个闹钟策略               │
│  • 不阻塞渲染                   • 到点批量转移任务            │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  3️⃣ 任务执行层：时间切片循环                                │
│                                                             │
│  workLoop                                                   │
│  • 从 taskQueue 取堆顶任务                                   │
│  • 过期任务必须完成，未过期任务可让出（5ms 切片）             │
│  • 支持任务续接（callback 返回函数）                         │
│  • 返回 true/false 驱动下一轮调度                           │
└─────────────────────────────────────────────────────────────┘
```

**机场比喻：**
- **任务管理层** = 两个停机区（就绪跑道 + 远程等待区）
- **异步调度层** = 两种通知方式（无线电 + 闹钟）
- **任务执行层** = 地勤组逐架处理，每轮 5ms 时间片

---

### 2.2 完整执行流程图

#### 第一步：scheduleCallback - 任务注册入口

```
外部调用
   ↓
┌─────────────────────────────────────┐
│  scheduleCallback(优先级, 回调)     │
│                                     │
│  1️⃣ 创建 Task 对象                  │
│     ├─ startTime (何时可以开始)     │
│     ├─ expirationTime (何时过期)   │
│     └─ priorityLevel (紧急程度)     │
└──────────────┬──────────────────────┘
               │
          2️⃣ 判断执行时机
               │
      ┌────────┴────────┐
      │                 │
   startTime > now   startTime ≤ now
   (还没到时间)       (现在就能执行)
      │                 │
      ↓                 ↓
┌────────────┐    ┌────────────┐
│ timerQueue │    │ taskQueue  │
│  [远程]    │    │  [就绪]    │
│            │    │            │
│ 3️⃣-A 设定时器│   │ 3️⃣-B 启动调度│
└────────────┘    └────────────┘
```

**形象比喻：**
- scheduleCallback = **机场塔台接待员**
- 收到飞机降落申请 → 检查飞机何时到达 → 分配到不同区域 → 发出指令

**实际流程：**
- 接收任务参数 → 计算时间属性 → 推入对应队列 → 触发调度机制

---

#### 第二步：执行启动 — requestHostCallback 到 workLoop

```
接上一步（就绪跑道 taskQueue 已有飞机）
      ↓
┌─────────────────────────────────────┐
│  1️⃣ requestHostCallback            │
│     检查：避免重复派遣              │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│  2️⃣ schedulePerformWorkUntilDeadline │
│     发送无线电指令                  │
└────────────────────────────────────┘
               ↓
         ⚡ 异步边界 ⚡
               ↓
┌─────────────────────────────────────┐
│  3️⃣ performWorkUntilDeadline       │
│     记录本轮开始时间                │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│  4️⃣ flushWork                      │
│     两道锁交接                      │
│     保存/恢复当前优先级             │
│     清空 currentTask                │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│  5️⃣ workLoop（核心）               │
│                                     │
│  • advanceTimers 转移到点任务       │
│  • while 堆顶循环：                 │
│    - 过期必须完成                   │
│    - 未过期且切片完可让出           │
│  • 执行 callback(是否过期)          │
│  • callback 可返回 continuation     │
│  • 安全 pop（检查堆顶是否易主）     │
│  • 底部：还有任务 or 设闹钟 or 收工 │
└──────────────┬──────────────────────┘
               │
          判断是否继续
               │
      ┌────────┴────────┐
      │                 │
  return true       return false
 （还有任务）      （就绪空了）
      │                 │
      ↓                 ↓
 再发无线电        设闹钟或收工
```

**形象比喻：**
- 塔台派地勤 → 无线电通知 → 地勤收到、记工时、换班 → **workLoop：问远程到点没、取堆顶最急的（油告警必须处理、油够且本轮时间到了可歇）、通知机组油情、降落可分段、清跑道、跑道空了看远程是否设闹钟** → 还有飞机就再发无线电

**实际流程：**
- `requestHostCallback` 防重 → `postMessage` 异步 → `performWorkUntilDeadline` 记 `startTime` → `flushWork` 锁交接、优先级保存
- **`workLoop`：**`advanceTimers` → `while` 堆顶 →「未过期 ∧ 该让」`break` → `callback(didUserCallbackTimeout)` → `continuation` 拆段或 `pop` → 底部「还有 → `true`」「远程有 → 闹钟」「空了 → `false`」→ 驱动 `schedulePerformWorkUntilDeadline` 再发或收工

---

#### 第三步：延迟任务唤醒 — requestHostTimeout 到 handleTimeout

```
接第一步 3️⃣-A 分支（任务进入 timerQueue）
      ↓
┌─────────────────────────────────────┐
│  1️⃣ requestHostTimeout             │
│     设置单个 setTimeout 闹钟        │
│     （只为堆顶，即最早到期的任务）  │
└──────────────┬──────────────────────┘
               │
               ↓
       ⏰ 异步等待 ⏰
    （setTimeout 计时中）
               │
               ↓
┌─────────────────────────────────────┐
│  2️⃣ handleTimeout                  │
│     闹钟响了，开始处理              │
│     • 关闭 isHostTimeoutScheduled   │
│     • 调用 advanceTimers            │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│  3️⃣ advanceTimers                  │
│     批量转移到点的任务              │
│     • 从 timerQueue 弹出            │
│     • 推入 taskQueue                │
└──────────────┬──────────────────────┘
               │
          检查转移结果
               │
      ┌────────┴────────┐
      │                 │
 taskQueue有任务   taskQueue仍空
      │                 │
      ↓                 ↓
┌────────────┐    ┌────────────┐
│requestHost │    │检查timerQueue│
│ Callback   │    │  堆顶       │
│            │    │            │
│进入第二步  │    │有→继续设闹钟│
└────────────┘    │无→待机      │
                  └────────────┘
```

**形象比喻：**
- 远程飞机预约 → 调度室挂闹钟（最早到达时间）→ 闹钟响 → 检查所有到点飞机，批量转到就绪跑道 → 跑道有飞机就派地勤，没飞机就继续设下个闹钟

**实际流程：**
- 任务进 `timerQueue` → `setTimeout(堆顶.startTime - now)` → 闹钟触发 `handleTimeout` → `advanceTimers` 批量转移 → 有任务则 `requestHostCallback`（进入第二步），无任务则递归设闹钟或待机

---

## 第三部分：任务注册入口：scheduleCallback（机场调度系统类比）

### 3.1 机场的基础设施

**两个区域：**

**就绪跑道（taskQueue）**：飞机已经到了，随时可以降落
- 按 `expirationTime` 排序（**燃油最少的在最前面**）
- 用最小堆存储，**堆顶是最紧急的飞机**

**远程等待区（timerQueue）**：飞机还没到，但已预约
- 按 `startTime` 排序（**最先到达的在最前面**）
- 用最小堆存储，**堆顶是最早到达的飞机**

---
**三个关键开关（锁）- 实测验证：**

| 锁名称 | 机场比喻 | 保护阶段 | 缺失影响（实测） |
|--------|----------|----------|----------------|
| **isMessageLoopRunning** | 机场大门的门卫<br>（核心防线） | 从"地勤出发"到"完成所有任务" | ❌ **灾难**<br>发多条消息 → performWorkUntilDeadline 多次调用 → 多个 workLoop 并发 → 全局变量被同时修改 |
| **isHostCallbackScheduled** | 塔台接待员<br>（第一道优化） | 从"发出工作单"到"地勤到达" | ⚠️ **性能浪费**<br>任务B、C到达 → requestHostCallback 被调用 3 次<br>（被 isMessageLoopRunning 拦住，但多 2 次函数调用） |
| **isPerformingWork** | 跑道警戒线<br>（第二道优化） | workLoop 执行期间 | ⚠️ **性能浪费**<br>任务A执行期间，任务D到达 → 通过检查 → requestHostCallback 被调用<br>（被 isMessageLoopRunning 拦住，但多 1 次函数调用） |

**三层防御关系：**

```
任务到达
  ↓
【第一层：isHostCallbackScheduled】 ← 性能优化，提前拦截"地勤在路上"期间的任务
  ↓ (通过)
【第二层：isPerformingWork】 ← 性能优化，提前拦截"地勤正在干活"期间的任务
  ↓ (通过)
requestHostCallback
  ↓
【第三层：isMessageLoopRunning】 ← 核心防御，防止发送多条消息
  ↓ (通过)
postMessage → 执行任务
```

**关键结论：**
- **isMessageLoopRunning** 是核心，只有它也能保证正确性（不会重复执行）
- **前两个锁是性能优化**，提前拦截任务，避免都挤到 requestHostCallback
- `isHostCallbackScheduled` 在 flushWork 开始时会被重置为 false，所以需要 `isPerformingWork` 配合保护执行期间

---

**三个锁的生命周期：**

```
1. scheduleCallback        → isHostCallbackScheduled = true（发工作单）
2. requestHostCallback     → isMessageLoopRunning = true（地勤出发）
3. flushWork 开始          → isHostCallbackScheduled = false, isPerformingWork = true（地勤到岗干活）
4. workLoop 结束           → isPerformingWork = false（地勤干完活）
5. 所有任务完成            → isMessageLoopRunning = false（地勤空闲）
```

---

**延迟任务的倒计时：**

**isHostTimeoutScheduled**：倒计时开关
- 记录"是否已经为最早到达的飞机设了闹钟"
- true = 已设置，false = 未设置

---

### 3.2 飞机申请降落的完整流程

#### 外部调用：scheduleCallback(优先级, callback, options?)

相当于：一架飞机联系塔台，申请降落许可

---

#### 步骤 1：确定飞机的到达时间（startTime）

```javascript
const currentTime = getCurrentTime(); // 当前时间，比如现在是 10:00
let startTime;

if (options?.delay > 0) {
  // 飞机还在路上，30分钟后到
  startTime = currentTime + delay;  // 10:30
} else {
  // 飞机已经到了
  startTime = currentTime;  // 10:00
}
```

**机场比喻：**
- `currentTime` = **现在几点**（10:00）
- `delay` = **飞机还需要飞多久**（30分钟）
- `startTime` = **飞机到达机场的时间**（10:30 或 10:00）

---

#### 步骤 2：计算燃油能撑多久（timeout）

```javascript
let timeout;
switch (priorityLevel) {
  case ImmediatePriority:
    timeout = -1;  // 紧急航班，燃油快没了，必须立刻降
    break;
  case UserBlockingPriority:
    timeout = 250;  // VIP航班，只能再撑250ms
    break;
  case NormalPriority:
    timeout = 5000;  // 普通航班，还能撑5秒
    break;
  case LowPriority:
    timeout = 10000;  // 货运航班，能撑10秒
    break;
  case IdlePriority:
    timeout = 很大的数;  // 空闲航班，燃油足够
    break;
}
```

**机场比喻：**
- `timeout` = **飞机到达后，燃油还能撑多久**
- **优先级越高，燃油越少，timeout 越小**

---

#### 步骤 3：计算最晚降落时间（expirationTime）

```javascript
const expirationTime = startTime + timeout;
```

**机场比喻：**
- `expirationTime` = **飞机最晚必须降落的时间**（再晚就坠毁了）
- 例如：飞机 10:30 到达（startTime），燃油只能撑 5 秒（timeout），那么 **10:30:05 必须降落完成**（expirationTime）

---

#### 步骤 4：制作飞机信息卡（Task 对象）

```javascript
const newTask = {
  id: taskIdCounter++,        // 航班号
  callback,                   // 降落程序
  priorityLevel,              // VIP/普通/货运
  startTime,                  // 到达时间
  expirationTime,             // 最晚降落时间
  sortIndex: -1               // 排序用，后面会填
};
```

---

#### 步骤 5：决定飞机去哪个区域

```javascript
if (startTime > currentTime) {
  // 飞机还没到，去远程等待区
  newTask.sortIndex = startTime;  // 按到达时间排序
  push(timerQueue, newTask);
  // ... 延迟分支逻辑
} else {
  // 飞机已经到了，去就绪跑道
  newTask.sortIndex = expirationTime;  // 按燃油耗尽时间排序
  push(taskQueue, newTask);
  // ... 即时分支逻辑
}
```

---

### 3.3 延迟分支详解（飞机还没到）

#### 场景：飞机 A 30分钟后到，飞机 B 20分钟后到

```javascript
// 飞机放入 timerQueue 后
if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
  // 条件：就绪跑道空着 && 新飞机是最早到的
  
  if (isHostTimeoutScheduled) {
    // 之前已经给其他飞机设了闹钟（比如飞机 A 30分钟）
    cancelHostTimeout();  // 取消旧闹钟
  } else {
    isHostTimeoutScheduled = true;
  }
  
  // 设置新闹钟（飞机 B 20分钟）
  requestHostTimeout(handleTimeout, startTime - currentTime);
}
```

**机场比喻：**

1. **只给最早到的飞机设闹钟**
   - 飞机 A：30分钟后到，设闹钟 30分钟
   - 飞机 B：20分钟后到，是最早的，**取消 30分钟闹钟，重设 20分钟闹钟**

2. **为什么只设一个闹钟？**
   - 闹钟响了之后，会调用 `handleTimeout`
   - `handleTimeout` 会检查 timerQueue，**把所有到时间的飞机都转到就绪跑道**
   - 所以只需要知道"最早到的是什么时候"即可

3. **为什么需要 isHostTimeoutScheduled？**
   - **防止多个闹钟同时在跑**
   - 新的更早的飞机来了，要先取消旧闹钟，再设新的

---

### 3.4 即时分支详解（飞机已经到了）

**场景：飞机 A 现在就要降落**

```javascript
// 飞机放入 taskQueue 后
if (!isHostCallbackScheduled && !isPerformingWork) {
  isHostCallbackScheduled = true;
  requestHostCallback();
}
```

**机场比喻：**

**检查条件：`!isHostCallbackScheduled && !isPerformingWork`**

> **关键：**两个条件必须**同时为 true**（都没问题）才发工作单，否则任务已入队，会被 workLoop 自动处理

**为什么需要两个条件？**
- **isHostCallbackScheduled**：拦截"地勤在路上"期间的任务（第一层）
- **isPerformingWork**：拦截"地勤正在干活"期间的任务（第二层）
- 因为 `flushWork` 开始时会重置 `isHostCallbackScheduled = false`，所以需要 `isPerformingWork` 来保护执行期间
- 最终都会被 `isMessageLoopRunning` 拦住，前两个锁只是性能优化

---

## 第四部分：任务执行启动流程 - requestHostCallback 到 workLoop

### 4.1 异步边界与 MessageChannel

**关键设计：异步边界**

```
同步阶段（立即执行）              异步阶段（稍后执行）
      ↓                                ↓
scheduleCallback              performWorkUntilDeadline
      ↓                                ↓
requestHostCallback                    ↓
      ↓                                ↓
postMessage(null) ────────→  port1.onmessage 触发
      ↓
  返回给调用者
（控制权交还）
```

**为什么使用 MessageChannel？**

| 方案 | 特性 | 问题 |
|------|------|------|
| 同步执行 | 立即执行所有任务 | ❌ 阻塞主线程，页面卡死 |
| setTimeout(fn, 0) | 异步执行 | ⚠️ 最小延迟约 4ms，相对较慢 |
| Promise.then | 微任务，优先级高 | ❌ 抢占渲染时机，可能卡顿 |
| **MessageChannel** | 宏任务，异步执行 | ✅ 延迟约 1ms，不阻塞渲染 |

**机场比喻：**
- 工作单不是「当面递到」地勤手里，而是通过**无线电**（MessageChannel）发出，地勤在另一端收听。
- 地勤只在**下一个时间点**才收到指令（下一个事件循环里执行 `performWorkUntilDeadline`）。
- 在「发报」到「收听到」这段时间里，机场（浏览器）可以处理别的事：**渲染页面、响应用户输入**。

---

### 4.2 从发出指令到执行任务的完整流程

#### 衔接：第三部分即时分支之后

相当于：飞机已在**就绪跑道**（taskQueue）排好序，塔台决定**派地勤出动**；下面是从「发无线电」到「真正处理飞机」的完整顺序。

---

#### 步骤 1：requestHostCallback — 同一波工作只开一条通道

```javascript
function requestHostCallback() {
  // 机场：isMessageLoopRunning = 「这一波出动是否已经安排上了」。
  // true → 不再重复发无线电，新来的飞机排队，同一波地勤依次处理。
  // false → 标记「这一波已派出」，并立刻发报（下一步）。
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    schedulePerformWorkUntilDeadline();
  }
}
```

---

#### 步骤 2：schedulePerformWorkUntilDeadline — 发无线电

```javascript
function schedulePerformWorkUntilDeadline() {
  // 机场：发一条极简口令「该进场干活」，不带具体机号；谁排在跑道上，地勤到了自己看队列。
  // 发报很快结束；真正进场要等收听到（4.1 异步边界）。
  port.postMessage(null);
}
```

---

#### 步骤 3：performWorkUntilDeadline — 收听到后开始本轮

```javascript
function performWorkUntilDeadline() {
  if (isMessageLoopRunning) {
    const currentTime = getCurrentTime();
    // 机场：本轮开工对表；后面「干了多久、该不该歇」都相对此刻。
    startTime = currentTime;
    let hasMoreWork = true;
    try {
      // 机场：进场、换班、上跑道干活（下一步 flushWork）。
      hasMoreWork = flushWork(currentTime);
    } finally {
      if (hasMoreWork) {
        // 机场：跑道还没清完或本轮先让出 → 再发一次无线电，下一拍接着干。
        schedulePerformWorkUntilDeadline();
      } else {
        // 机场：这一波收工，「已派出」标记关掉；以后再从步骤 1 走。
        isMessageLoopRunning = false;
      }
    }
  }
}
```

---

#### 步骤 4：flushWork — 换班（接上第三部分两道锁）

```javascript
function flushWork(initialTime) {
  // 机场：第一张条子撕掉——「调度条子已送达」，地勤在路上的阶段结束（对应 3.1 / 3.4 第一道）。
  isHostCallbackScheduled = false;
  // 机场：第二张条子贴上——「正在跑道上干活」，别为同一波活再叠一层发报（第二道）。
  // 先 false 再 true：不留空窗，始终要么在赶来要么在干活；核心仍由 isMessageLoopRunning 兜住。
  isPerformingWork = true;

  // 进本轮前记下对外「当前优先级」；workLoop 里会改成正在跑的那架；finally 里还原 = 收工后不再代表某一架。
  // 机场：收工清点——黑板上的「当前代表哪架」擦掉，避免泄漏到下一轮（getCurrentPriorityLevel 语义）。
  let previousPriorityLevel = currentPriorityLevel;
  try {
    return workLoop(initialTime);
  } finally {
    // 机场：不再指着某一架；与上面还原优先级一起，收工清空黑板。
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    isPerformingWork = false;
  }
}
```

---

#### 步骤 5：workLoop — 按堆顶顺序处理，必要时让出

下面与 `Scheduler.ts` 中 `workLoop` 结构一致；**步骤 1～4 与步骤 5 相同：机场比喻与要点都写在代码注释里**，对着读即可。

```javascript
function workLoop(initialTime) {
  let currentTime = initialTime;

  // 机场：问远程等待区——有没有到点、可以转进就绪跑道的飞机？
  advanceTimers(currentTime);
  currentTask = peek(taskQueue);

  while (currentTask !== null) {
    // 为何用 &&：既要「任务还能拖（expirationTime > currentTime）」又要「本轮切片用完了」才 break；
    // 若用 ||，已过期任务也可能被「该歇口气了」误停。机场：油没告警且本轮该歇了才刹一脚。
    if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
      break;
    }

    const callback = currentTask.callback;
    if (typeof callback === "function") {
      // 取出要执行的函数后立刻置 null：这一段已交给地勤，避免同一段被重复执行。
      currentTask.callback = null;
      // 外界 getCurrentPriorityLevel() 读到的是「此刻正在处理哪一档优先级」。
      currentPriorityLevel = currentTask.priorityLevel;
      // 相对此刻是否已误点（过期）；传给 callback，业务可少做或换路径。
      // 机场：塔台顺带喊「燃油告警灯亮没亮」——true 表示已过最晚时刻，可走「先保安全、少做细活」。
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();

      if (typeof continuationCallback === "function") {
        // 同一任务没完，还要一截；别在这次无线电里死磕，下一拍再接。
        // 机场：同一架分多趟降落，这一趟先结束。
        currentTask.callback = continuationCallback;
        advanceTimers(currentTime);
        return true;
      }
      // —— 走到这里：continuation 不是 function，表示「用户 callback 这一小段已经跑完」——
      // 为什么还要 if (currentTask === peek) 才 pop？「还会相等吗？」——会，而且很常见。
      //   常见情况：回调里根本没 schedule，或只 schedule 了更晚过期（更不紧急）的任务，堆顶仍是刚跑完这条 → 必须 pop，否则这条 null callback 永远占着堆顶。
      //   少数情况：回调里 schedule 了更紧急的任务，堆重排后堆顶换成别人 → 不能 pop；盲 pop 会误删新来的那条。
      //   pop() 永远只删堆顶，所以用「是否仍是堆顶」区分这两种情况。
      //   若 peek 已是别人：当前这条还在堆里更深的位置，等它以后再升到堆顶时，会因 callback 非函数走外层 else 被 pop 掉。
      if (currentTask === peek(taskQueue)) {
        pop(taskQueue);
      }
      // 刚跑完一个任务，currentTime 已更新；再问一遍远程等待区：有没有到点该进跑道的（与是否 pop 无关，例行推进）。
      advanceTimers(currentTime);
    } else {
      // callback 非函数（如 cancelCallback 清空）：堆顶废条目，直接弹出。
      pop(taskQueue);
    }

    currentTask = peek(taskQueue);
  }

  // —— while 结束：只有两种离开方式，先分清再走下面三句 ——
  // 方式 A：上面 break 了（让出）。本轮没跑完堆顶，最后一行「currentTask = peek」没执行到，currentTask 仍指向「该接着处理的那架」→ 非 null。
  // 方式 B：while 条件变假正常退出。最后一轮末尾执行了 currentTask = peek(taskQueue)，堆已空 → currentTask 为 null。

  if (currentTask !== null) {
    // 方式 A：就绪跑道还有飞机在等 → 告诉 performWorkUntilDeadline：hasMoreWork，再 postMessage 一轮。
    // 机场：刹一脚让机场喘口气，跑道上那架还在原地，下一声无线电再来接它。
    return true;
  }

  const firstTimer = peek(timerQueue);
  if (firstTimer !== null) {
    // 方式 B 且「就绪跑道空、远程等待区还有人」：立刻再发无线电只会空转，改用 setTimeout 睡到「下一架该进场」的时刻；
    // 铃响进 handleTimeout → advanceTimers 进跑道 → 必要时再 requestHostCallback。
    // 机场：跑道上没人了，但远处有预约机，设闹钟到点再喊，不一直占着无线电频道。
    requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
  }
  // 方式 B 的收尾：就绪跑道已空；要么连远程也没有，要么已经交给上面的闹钟。
  // return false = 告诉上层「不必马上再排一轮 MessageChannel」；若有闹钟，下一动因是 setTimeout，不是立刻再 postMessage。
  return false;
}
```

---

## 第五部分：延迟任务的唤醒机制 - handleTimeout 与 timerQueue

### 5.1 延迟任务的调度策略

**核心问题：延迟任务（delay > 0）如何调度？**

当 `scheduleCallback` 的 `options.delay > 0` 时，任务不能立即执行，需要等待。如果把这些任务也放入 `taskQueue`，会导致：
- ❌ 占用堆空间（可能有大量远期任务）
- ❌ `workLoop` 每次都要跳过未到期的任务（浪费 CPU）
- ❌ 无法高效判断"最早什么时候有任务到期"

**解决方案：timerQueue + 单个 setTimeout**

```
延迟任务管理策略
      ↓
┌─────────────────────────────────────────┐
│  timerQueue（远程等待区）                │
│  • 按 startTime 排序（最早到的在堆顶）   │
│  • 只存储未到期的任务                    │
│  • 堆顶 = 下一个要醒来的任务             │
└──────────────┬──────────────────────────┘
               │
          设置单个闹钟
          (requestHostTimeout)
               │
               ↓
    setTimeout(handleTimeout, delay)
    • 只为"最早到期"的任务设闹钟
    • 闹钟响 → 批量转移所有到期任务
               │
               ↓
    ┌──────────────────────┐
    │  handleTimeout       │
    │  1. 关闭闹钟标志      │
    │  2. advanceTimers    │
    │  3. 决定下一步       │
    └──────┬───────────────┘
           │
      ┌────┴────┐
      │         │
  有任务转移   没任务转移
      │         │
      ↓         ↓
requestHostCallback  继续设下一个闹钟
 （进入第四部分）   或进入待机
```

**为什么只设置"单个"闹钟？**

| 策略 | 做法 | 问题 |
|------|------|------|
| 每个任务一个闹钟 | 100个延迟任务 → 100个 setTimeout | ❌ 内存浪费，管理复杂 |
| 轮询检查 | setInterval 每秒检查 | ❌ CPU 浪费，响应不及时 |
| **单个闹钟（采用）** | 只为堆顶（最早到期）设闹钟 | ✅ 节省资源，精确唤醒 |

**动态调整策略：**

```javascript
// 场景 1：新任务比当前闹钟更早
timerQueue 堆顶: 任务A (30分钟后)  ← 已设闹钟
新任务B: 20分钟后 → 进堆后成为新堆顶
  ↓
cancelHostTimeout()           // 取消任务A的闹钟
requestHostTimeout(20分钟)    // 为任务B设新闹钟

// 场景 2：新任务比当前闹钟晚
timerQueue 堆顶: 任务A (10分钟后)  ← 已设闹钟
新任务C: 30分钟后 → 进堆但不是堆顶
  ↓
不做任何操作                  // 闹钟响后会一起处理
```

**与 taskQueue 的协同：**

| 队列 | 任务状态 | 触发机制 | 执行方式 |
|------|---------|---------|---------|
| **taskQueue** | 立即可执行 | MessageChannel | 立即派遣地勤（第四部分） |
| **timerQueue** | 等待中 | setTimeout | 闹钟响 → 转移 → 派遣地勤 |

**机场比喻：**
- **远程等待区（timerQueue）**：预约了降落时间但还没到的飞机，停在远处
- **单个闹钟**：调度室只挂一个闹钟，设为"下一架最早到达的时间"
- **闹钟响了（handleTimeout）**：
  1. 检查远程等待区，所有到点的飞机一起转移到就绪跑道
  2. 跑道有飞机 → 立刻派地勤
  3. 跑道空但远程还有 → 继续设下一个闹钟
- **动态更新**：新飞机预约了更早的时间 → 取消旧闹钟，设新闹钟

---

### 5.2 从设置闹钟到任务启动的完整流程

这部分对应第三部分 `scheduleCallback` 的 **3️⃣-B 分支**：任务被放入 `timerQueue` 后，设置闹钟、等待闹钟响起、转移任务、启动执行的完整流程。

---

#### 步骤 1：requestHostTimeout — 设置闹钟

```javascript
function requestHostTimeout(
  callback: (currentTime: number) => void,
  ms: number
) {
  // 机场：远程等待区有飞机预约，但还没到 → 设置一个闹钟，到点了自动提醒。
  // ms = 飞机预计到达时间（startTime）- 现在（currentTime）= 还要等多久。
  // callback = handleTimeout，闹钟响了之后要执行的函数。
  
  // 为什么用 setTimeout？
  // 因为任务还没到执行时间，不能立刻放到 taskQueue，也不能占用主线程一直轮询。
  // setTimeout 是浏览器提供的定时器，到时自动触发，不阻塞主线程。
  
  // 机场：在调度室挂一个闹钟，到点了会响，提醒我们「有飞机到了，该去接了」。
  taskTimeoutID = setTimeout(() => {
    // 机场：闹钟响了 → 调用 handleTimeout，传入「现在是几点」。
    callback(getCurrentTime());
  }, ms);
}
```

---

#### 步骤 2：handleTimeout — 闹钟响了，检查远程等待区

```javascript
function handleTimeout(currentTime: number) {
  // 机场：闹钟响了 → 关闭「闹钟标志」，准备处理到点的飞机。
  isHostTimeoutScheduled = false;

  // 机场：检查远程等待区，把所有到点的飞机转移到就绪跑道。
  advanceTimers(currentTime);

  // ⚠️ 检查「地勤标志」isHostCallbackScheduled（不是上面的「闹钟标志」！）
  if (!isHostCallbackScheduled) {
    // 机场：地勤没派出 → 检查就绪跑道上是否有飞机。
    if (peek(taskQueue) !== null) {
      // 机场：跑道有飞机 → 派地勤出发（进入第四部分流程）。
      isHostCallbackScheduled = true;
      requestHostCallback();
    } else {
      // 机场：跑道空 → 检查远程是否还有更晚的预约，有就继续设闹钟。
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
      // 机场：如果 timerQueue 也空了 → 进入待机状态，等下次 scheduleCallback。
    }
  }
  // 机场：如果地勤已在路上或在干活 → 转移的任务会被 workLoop 自然处理，无需再管。
}
```

**🔍 关键细节解释：**

1. **两个不同的标志**：
   - `isHostTimeoutScheduled`（闹钟标志）：是否有 `setTimeout` 闹钟在运行
   - `isHostCallbackScheduled`（地勤标志）：是否已经派出地勤（`requestHostCallback` 是否已调用）

2. **为什么要检查 `isHostCallbackScheduled`？**
   
   因为可能存在并发场景：
   
   **场景 1：闹钟响之前，有新任务直接进了 taskQueue**
   - 新的立即任务（`startTime ≤ now`）通过 `scheduleCallback` 直接进 `taskQueue`
   - `scheduleCallback` 的 3️⃣-A 分支已经调用了 `requestHostCallback`
   - `isHostCallbackScheduled` 已经是 `true`
   - 此时闹钟响了，但地勤已经在路上了，不需要再派一次
   
   **场景 2：workLoop 正在执行任务**
   - `workLoop` 还在处理任务，`isHostCallbackScheduled` 或 `isPerformingWork` 是 `true`
   - 此时闹钟响了，转移任务后发现地勤还在干活
   - 转移到 `taskQueue` 的任务会被正在运行的 `workLoop` 自然处理掉

3. **为什么 `advanceTimers` 要转移"所有"到点的任务？**
   
   因为 `setTimeout` 只保证"最早到点"时响一次，可能有多架飞机同时或接连到点，所以在 `advanceTimers` 内部用 `while` 循环一次性全转过来。

4. **`firstTimer.startTime - currentTime` 的含义**：
   - `startTime`：飞机预计到达时间（绝对时间）
   - `currentTime`：现在（绝对时间）
   - 相减 = 还要等多久（相对时间），这就是 `setTimeout` 的延迟参数

---

#### 步骤 3：advanceTimers — 批量转移到点的任务

```javascript
function advanceTimers(currentTime: number) {
  // 机场：从远程等待区（timerQueue）堆顶开始检查。
  let timer = peek(timerQueue);
  
  while (timer !== null) {
    if (timer.callback === null) {
      // 机场：这架飞机被取消了（被 cancelCallback 标记），直接移除。
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // 机场：这架飞机已经到点了 → 从远程等待区移除。
      pop(timerQueue);
      
      // 机场：修改排序索引 → 进入就绪跑道后，按「燃油紧急度」（expirationTime）排序。
      // 之前在 timerQueue 是按「到达时间」（startTime）排，现在要按「过期时间」排。
      timer.sortIndex = timer.expirationTime;
      
      // 机场：推入就绪跑道（taskQueue），等待地勤处理。
      push(taskQueue, timer);
    } else {
      // 机场：堆顶的飞机还没到点 → 后面的更晚（最小堆特性），不用再看了，直接返回。
      return;
    }
    
    // 机场：处理完一架，继续检查下一个堆顶（可能有多架飞机同时到点）。
    timer = peek(timerQueue);
  }
}
```

**🔍 关键细节解释：**

1. **为什么用 `while` 循环？**
   
   因为可能有多个任务的 `startTime` 相同或接近，一次闹钟响起需要把所有到点的任务都转移过去。

2. **为什么检查 `timer.callback === null`？**
   
   **会出现这种情况！** 当任务被取消时（调用 `cancelCallback`）。
   
   ```javascript
   function cancelCallback() {
     currentTask!.callback = null;  // 只是标记为 null，不从队列删除
   }
   ```
   
   **为什么只标记 null，不直接删除？**
   - 因为**最小堆无法高效删除中间元素**（只能 `pop` 堆顶）
   - 如果要删除中间元素，需要重新调整整个堆，成本很高
   - 采用"懒删除"策略：标记为 `null`，在后续处理时顺便清理
   
   **什么时候会调用 `cancelCallback`？**
   - 组件卸载时，取消之前 schedule 的渲染任务
   - 新的高优先级任务到来，取消旧的低优先级任务
   - 用户交互打断了之前的任务
   
   **清理时机：**
   - `advanceTimers`：转移任务时顺便清理（本步骤 3）
   - `workLoop`：执行任务时发现 `callback === null`，直接跳过并 `pop`（第四部分步骤 5）
   
   这种设计在 `timerQueue` 中尤其重要，因为延迟任务可能在等待期间被取消，避免等到闹钟响了还要执行无效任务。

3. **为什么 `startTime > currentTime` 就直接 `return`？**
   
   因为 `timerQueue` 是按 `startTime` 排序的最小堆：
   - 堆顶是最早到的
   - 如果堆顶都没到点，后面的肯定更晚
   - 不需要继续遍历，提前退出节省性能

4. **这个函数在哪些地方被调用？**
   - `handleTimeout`：闹钟响了，检查并转移（本步骤 2）
   - `workLoop`：每次执行任务前，先检查是否有到点的延迟任务（第四部分步骤 5）
   - `scheduleCallback`：新任务到达时，也会检查一次（第三部分 3.2）

---

## 第六部分：常见问题与深入理解（Q&A）

### Q1: React 的调度器是怎么实现的，大致实现思路是什么，有什么注意点？

**核心思路：优先级 + 时间切片 + 异步调度**

#### 一、整体架构（三层设计）

```
┌─────────────────────────────────────────┐
│  1. 任务分类与存储层                     │
│     • taskQueue：立即可执行的任务        │
│     • timerQueue：延迟任务              │
│     • 用最小堆按优先级排序               │
└──────────────┬──────────────────────────┘
               ↓
┌─────────────────────────────────────────┐
│  2. 异步调度层                          │
│     • MessageChannel：立即任务调度       │
│     • setTimeout：延迟任务唤醒          │
└──────────────┬──────────────────────────┘
               ↓
┌─────────────────────────────────────────┐
│  3. 执行控制层                          │
│     • workLoop：循环执行任务            │
│     • 时间切片：5ms 让出控制权           │
│     • 任务续接：支持中断和恢复           │
└─────────────────────────────────────────┘
```

#### 二、核心实现思路（按执行流程）

**1️⃣ 任务注册（scheduleCallback）**

```javascript
// 关键步骤
1. 计算时间属性
   - expirationTime = 当前时间 + 优先级对应的超时时间
   - startTime = 当前时间 + delay（如果有延迟）

2. 分流入队
   - startTime > now → timerQueue（延迟队列）
   - startTime ≤ now → taskQueue（立即队列）

3. 触发调度
   - 进 taskQueue → requestHostCallback（立即调度）
   - 进 timerQueue → requestHostTimeout（设闹钟）
```

**2️⃣ 立即任务调度（MessageChannel）**

```javascript
requestHostCallback()
  → postMessage(null)  // 异步边界，不阻塞
    → performWorkUntilDeadline()  // 下一个事件循环
      → flushWork()
        → workLoop()  // 核心执行循环
```

**为什么用 MessageChannel？**
- `setTimeout(fn, 0)`：最小延迟约 4ms
- `Promise.then`：微任务，会抢占渲染
- **MessageChannel**：宏任务，约 1ms，不阻塞渲染 ✅

**3️⃣ 任务执行循环（workLoop）**

```javascript
while (currentTask !== null) {
  // 1. 优先级判断：过期必须完成，未过期可让出
  if (currentTask.expirationTime > now && shouldYield()) {
    break;  // 时间切片用完，让出控制权
  }
  
  // 2. 执行任务
  const callback = currentTask.callback;
  const continuationCallback = callback(didTimeout);
  
  // 3. 任务续接：callback 返回函数 = 任务未完成
  if (typeof continuationCallback === 'function') {
    currentTask.callback = continuationCallback;  // 下次继续
  } else {
    pop(taskQueue);  // 任务完成，移除
  }
}

// 4. 返回值驱动递归
return peek(taskQueue) !== null;  // 还有任务 → 再发 postMessage
```

**4️⃣ 延迟任务唤醒（setTimeout）**

```javascript
// 单个闹钟策略
requestHostTimeout(handleTimeout, 最早任务的 delay)
  ↓
setTimeout 到期触发
  ↓
handleTimeout()
  → advanceTimers()  // 批量转移所有到期任务
    → 有任务 → requestHostCallback()  // 进入立即调度流程
```

#### 三、关键设计点与注意事项

**🔑 设计点 1：三层防护锁**

```javascript
// 防止并发冲突的三道锁
1. isMessageLoopRunning（核心锁）
   - 防止多个 MessageChannel 同时运行
   - 在 requestHostCallback 设置，performWorkUntilDeadline 结束时清除

2. isHostCallbackScheduled（优化锁）
   - 防止重复调用 requestHostCallback
   - 在"派遣"时设置，"到达"时清除

3. isPerformingWork（优化锁）
   - 防止 workLoop 执行期间重复调度
   - 在 flushWork 设置和清除
```

**🔑 设计点 2：最小堆排序**

```javascript
// 不同队列，不同排序依据
taskQueue：按 expirationTime 排序  → 谁最紧急谁先执行
timerQueue：按 startTime 排序      → 谁最早到谁先醒来

// 任务从 timerQueue 转到 taskQueue 时
timer.sortIndex = timer.expirationTime;  // 修改排序索引
```

**🔑 设计点 3：懒删除策略**

```javascript
// 取消任务：只标记 null，不删除
function cancelCallback() {
  currentTask.callback = null;  // 标记为无效
}

// 清理时机：在必经之路顺便清理
- advanceTimers 转移时清理
- workLoop 执行时跳过
```

**🔑 设计点 4：时间切片与任务续接**

```javascript
// 5ms 切片机制
const frameInterval = 5;  // 默认 5ms
shouldYieldToHost() {
  return getCurrentTime() - startTime >= frameInterval;
}

// 任务续接：支持长任务分片执行
function longTask() {
  // 处理一部分数据
  if (还有更多数据) {
    return longTask;  // 返回自己，下次继续
  }
}
```

#### 四、面试要点总结

**用一句话概括：**
React Scheduler 通过**最小堆管理优先级队列**，用 **MessageChannel 实现异步调度**，在 **workLoop 中以时间切片方式执行任务**，支持**任务中断和续接**，延迟任务通过**单个 setTimeout 批量唤醒**。

**机场类比总结：**
- **taskQueue** = 就绪跑道（飞机按燃油紧急度排队）
- **timerQueue** = 远程等待区（飞机按到达时间排队）
- **MessageChannel** = 无线电系统（派遣不阻塞）
- **setTimeout** = 单个闹钟（最早到的设闹钟）
- **workLoop** = 地勤组（逐架处理，时间到了可让出）
- **时间切片** = 每轮只干 5ms（让出控制权给渲染）

**关键优势：**
1. **不阻塞渲染**：异步调度 + 时间切片
2. **优先级保证**：高优先级任务先执行
3. **长任务友好**：支持任务中断和恢复
4. **资源高效**：单个闹钟 + 懒删除

---

### Q2: 调度器的完整调用栈是什么，每个函数的主要作用是什么？

**核心：两条主路径 + 两个递归循环**

---

#### 📊 路径 1：立即任务执行路径（taskQueue）

```
外部调用
   ↓
scheduleCallback(priority, callback, {delay})
   └─ 作用：任务注册入口，计算时间，分流队列
   ↓
   (startTime ≤ now，进入 taskQueue)
   ↓
requestHostCallback()
   └─ 作用：启动异步调度
   └─ 关键：检查 isMessageLoopRunning，设为 true
   ↓
schedulePerformWorkUntilDeadline()  ◄──────────────────────────┐ (递归起止点)
   └─ 作用：发送异步消息，触发异步循环                         │
   └─ 关键：port.postMessage(null)                            │
   ↓                                                           │
   ⚡ 异步边界（下一个事件循环）⚡                               │
   ↓                                                           │
performWorkUntilDeadline()                                     │
   └─ 作用：异步回调入口，决定是否继续递归                      │
   └─ 关键：startTime = getCurrentTime()                      │
   ↓                                                           │
flushWork(initialTime)                                         │
   └─ 作用：锁交接，保存/恢复优先级                             │
   └─ 关键：isHostCallbackScheduled → isPerformingWork        │
   ↓                                                           │
workLoop(initialTime)                                          │
   └─ 作用：核心执行循环                                       │
   └─ 关键：                                                  │
      • advanceTimers() 转移到点任务                           │
      • while 堆顶：过期必须完成，未过期可让出                  │
      • 执行 callback，支持续接                                │
      • 返回 true/false 驱动下一轮                            │
   ↓                                                           │
return true (还有任务 or 时间切片用完)                          │
   ↓                                                           │
回到 performWorkUntilDeadline                                  │
   ↓                                                           │
hasMoreWork = true                                             │
   ↓                                                           │
【递归】performWorkUntilDeadline 同步调用                       │
   ↓                                                           │
schedulePerformWorkUntilDeadline() ────────────────────────────┘

(递归：schedulePerformWorkUntilDeadline 被反复调用，触发异步循环)
```

---

#### 📊 路径 2：延迟任务唤醒路径（timerQueue）

```
外部调用
   ↓
scheduleCallback(priority, callback, {delay})
   └─ 作用：任务注册入口
   ↓
   (startTime > now，进入 timerQueue)
   ↓
requestHostTimeout(handleTimeout, delay)  ◄────────────────────┐ (递归起止点)
   └─ 作用：设置 setTimeout 闹钟，触发异步等待                  │
   └─ 关键：只为堆顶（最早到期）设一个闹钟                      │
   ↓                                                           │
   ⏰ 异步等待（setTimeout 计时中）⏰                            │
   ↓                                                           │
handleTimeout(currentTime)                                     │
   └─ 作用：闹钟响了，决定是否继续递归                          │
   └─ 关键：                                                  │
      • isHostTimeoutScheduled = false                        │
      • 调用 advanceTimers 批量转移                           │
      • 根据结果决定下一步                                    │
   ↓                                                           │
advanceTimers(currentTime)                                     │
   └─ 作用：批量转移到点的任务                                  │
   └─ 关键：while 循环，startTime ≤ now 的全转移              │
   ↓                                                           │
   ┌────────┴────────┐                                        │
   │                 │                                        │
taskQueue      taskQueue                                      │
  有任务           空                                           │
   │                 │                                        │
   ↓                 ↓                                        │
requestHost    timerQueue 还有？                               │
Callback()          │                                         │
   │                ↓                                         │
   │              YES                                         │
   │                ↓                                         │
进入路径 1    【递归】handleTimeout 同步调用                     │
                    │                                         │
                    ↓                                         │
              requestHostTimeout(handleTimeout, delay) ───────┘

(递归：requestHostTimeout 被反复调用，触发异步等待)
```

---

#### 🎯 关键理解要点

**两个递归函数（递归起止点）：**

1. **立即任务递归：schedulePerformWorkUntilDeadline**
   - 递归路径：`schedulePerformWorkUntilDeadline` → `postMessage` → 异步触发 `performWorkUntilDeadline` → 同步调用 `schedulePerformWorkUntilDeadline`
   - 递归条件：`performWorkUntilDeadline` 内部判断 `hasMoreWork = true` 时调用
   - 终止条件：`workLoop` 返回 `false`
   - **关键**：它在同步调用栈中被反复调用，是递归的"触发执行点"

2. **延迟任务递归：requestHostTimeout**
   - 递归路径：`requestHostTimeout` → `setTimeout` → 异步触发 `handleTimeout` → 同步调用 `requestHostTimeout`
   - 递归条件：`handleTimeout` 内部判断 `timerQueue` 还有任务时调用
   - 终止条件：`timerQueue` 为空
   - **关键**：它在同步调用栈中被反复调用，是递归的"触发执行点"

---

