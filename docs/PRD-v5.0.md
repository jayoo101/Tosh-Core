# Tosh Fair Launchpad v5.0 —— 产品需求文档（PRD）

> **文档性质**：本文档是**反向提取**的产品需求文档。它不是设计蓝图，而是对 `Tosh-Core` 仓库当前代码的逐行反推结果，目的是让产品负责人能够逐条核对"实现是否符合设想"。
>
> **取证方式**：主体是纯静态阅读；后续的修订轮次（含 §8.26–8.31 红队、§8.32–8.34 gas 复查）则是跑过 `forge build` / `forge test` 的，其中的 gas 数字全部来自 `forge test --isolate --gas-report` 实测而非估算。所有常量与函数名都标注了来源文件；**早期的行号引用大多已经腐烂**，因为克隆重构与存储打包移动了大量代码——以符号名为准，不要以行号为准。
>
> **标注约定**：
> - **⚠️ 需确认** —— 代码里客观存在，但可能与产品直觉不符的地方。全部条目在第 8 章汇总。
> - **代码中未找到依据** —— 我无法在代码里找到支撑的内容，不做编造。
>
> **审阅范围**：`src/`（4 个核心合约 + 3 个库）、`script/`（5 个部署脚本）、`test/`（10 个测试文件，其中 `ToshV5*.t.sol` 是 v5.0 的验收套件）、`soat-frontend/`（Next.js dApp）。
>
> 上面这三个数字曾分别写作 2 个库、14 个测试文件——库漏掉了 EIP-1167 克隆重构新增的 `ToshCloneLib.sol`，测试文件数则是套件合并成 `ToshV5*` 家族之前的旧值。这类计数在文档里天然会腐烂，且腐烂时不报错。

---

## 目录

1. [产品概述与定位](#1-产品概述与定位)
2. [系统架构与角色定义](#2-系统架构与角色定义)
3. [代币经济与资产流模型](#3-代币经济与资产流模型)
4. [产品全生命周期与业务流程](#4-产品全生命周期与业务流程)
5. [安全与反操纵机制](#5-安全与反操纵机制)
6. [前端与用户交互规格](#6-前端与用户交互规格)
7. [附录：常量、事件、错误码总表](#7-附录常量事件错误码总表)
8. [⚠️ 需确认条目汇总](#8-需确认条目汇总)

---

## 1. 产品概述与定位

### 1.1 一句话定义

Tosh Fair Launchpad v5.0 是一个**100% ETH 原生**的公平发射平台，每个项目在 **Uniswap V4** 上以一个专属 Hook 合约作为发射引擎，把「创世募集 → 建池开盘 → 二级市场 + 离散阶梯增发」三个阶段全部搬到链上，并用**平台级回购销毁飞轮**把交易摩擦转化为通缩动力。

### 1.2 解决什么问题

代码注释把设计动因写得很直接（`src/ToshLaunchpadHook.sol:41-125`、`src/ToshFactory.sol:20-35`）。归纳成产品语言：

| # | 常见 launchpad 的问题 | v5.0 的处理 | 代码依据 |
|---|---|---|---|
| 1 | 需要先买平台币（SATO 之类）才能参与，制造了额外的准入摩擦和平台币庄家风险 | 全链路 ETH 原生：发射费、创世出资、货架铸造、回购弹药、退款，全部是原生 ETH。工厂甚至不再存储 SATO 地址 | `src/ToshFactory.sol:59-62`；`src/ToshLaunchpadHook.sol:43-46` |
| 2 | 项目方持有大额预挖，区块浏览器上一个地址占 100% 供应，社区不敢进 | 按需铸造（on-demand mint）。开盘时只铸 8.4M 创世块，其余 12.6M 随货架成交逐笔铸出 | `src/ToshToken.sol:35-39`、`mint` @ `src/ToshToken.sol` |
| 3 | 项目方可以从低价曲线铸币砸回底池，抽干创世 ETH | 三重价格门控：同区块铸造禁令 + `min(spot, TWAP)` 参考价 + 105% 天花板。开盘那个区块 Phase-2 **完全关闭**——由 `launch()` 主动盖上 `lastSwapBlock` 强制，而非依赖边界算术（见 §8.26） | `ToshLaunchpadHook.launch()` / `mintBondingCurve`；测试 `test_ladderOpensLockedAtLaunch` + `test_ladderOpensLockedAtLaunch_acrossRaiseSizes` |
| 4 | 创世参与者开盘就被套（开盘价 ≤ 出资成本） | 55/45 的创世供应切分在数学上制造出**恰好 10%** 的开盘账面溢价，货架 0 再叠 5%，合计 15.5% | `GENESIS_CLAIM_SUPPLY` / `GENESIS_LP_SUPPLY` @ `src/ToshLaunchpadHook.sol`；测试 `test_genesisPremium_isExactlyTenPercent` @ `test/ToshV5.t.sol` |
| 5 | 底池被永久锁死，散户不敢也不能做 LP，池子费收给了无人能领的仓位 | v5.0 从地址掩码里**移除** `BEFORE_REMOVE_LIQUIDITY`（0x22CC → 0x20CC），散户 LP 自由进出；创世仓位靠"归属权 + 无移除代码路径"结构性锁定 | `src/ToshLaunchpadHook.sol:73-88`、`beforeRemoveLiquidity`；测试 `test_retailLp_canAddAndRemoveWithoutTouchingGenesis` @ `test/ToshV5.t.sol` |
| 6 | 通缩靠链下机器人 harvest，有 MEV 风险和运维成本 | 顺风车（piggyback）回购：Tosh 池交易的 `afterSwap` 在**有 gas 余量时**顺手买入一份并销毁到 `0xdead`；每次一条腿，投放额 `max(1 ETH, 余额 10%)` 除以 `BATCH_SIZE` 分仓。无链下组件——但也不再保证交易一定会带上回购，兵底是无许可的 `pokeBuyback()`（见 §4.9、8.32） | `afterSwap` @ `src/ToshLaunchpadHook.sol`；`autoPiggybackBuyback` / `pokeBuyback` @ `src/ToshLadderTreasury.sol` |
| 7 | 平台金库可以被 owner 提走 | 国库是**单向阀**：无 `withdraw` / `sweep` / `rescue` / `delegatecall`，唯一出金路径 `_buyAndBurn` 的收款地址硬编码为 `0xdead` | `src/ToshLadderTreasury.sol:37-51`、`327-352` |

### 1.3 目标用户

| 用户 | 诉求 | 产品提供的东西 |
|---|---|---|
| **项目创作者（creator）** | 用最小成本开一个有真实底池、有可信规则的代币 | 0.1 ETH 发射费；三档创世时长可选；99% 货架收入归 `projectAdmin`；规则在部署时冻结进 immutable |
| **创世储户** | 早期低价 + 确定的下行保护 | 结构性 10% 开盘溢价；软顶未达成 / 7 天僵尸窗口超时可 100% 无罚退款 |
| **二级交易者** | 有深度、无隐藏抽水的池子 | 全区间创世流动性永久锁定；总摩擦 1.00%（0.3% 给 LP + 0.7% 协议） |
| **散户 LP** | 赚池子费而不被锁仓 | 0.30% 池子费由 V4 原生结算；随时可撤；UI 提供极简全区间面板 |
| **推荐人** | 拉新分佣 | 全平台终身绑定，被推荐人**每一次**创世出资的 10% 都归推荐人（⚠️ 见 8.3：官方 UI 目前不传推荐人） |
| **平台 owner** | 平台可运营但不可作恶 | 可调发射费 / 软顶 / 额度 / 冷却 / 黑名单 / 暂停 / 回购策展；但**不能**动任何一分资金 |

### 1.4 与常见 launchpad 的差异总结

- **不是 bonding-curve-only**：v5.0 有**真实的 Uniswap V4 池子**（Phase 1 结束就建池），阶梯货架（Phase 2）是**平行于池子**的一级增发渠道，且被池子的价格反向门控。这与 pump.fun 类"曲线内交易，毕业后才建池"是完全不同的结构。
- **不是 tan(z) 连续曲线**：v4.x 的泰勒展开切线曲线被删除，换成 4000 档**离散定价货架**（`TIER_COUNT = 4000`，每档 3,150 枚，档间 +0.19025%，全程跨度 2000×），价格用快速幂闭式求值而非累乘，避免 4000 次截断漂移（`src/ToshLaunchpadHook.sol`）。
- **卖压直接销毁**：卖出侧 0.7% 的代币在 `beforeSwap` 里就被 `take` 到 `0xdead`，不进储备、不需要回购换手（`_skimInputTax` @ `src/ToshLaunchpadHook.sol`）。
- **平台收入不是利润**：发射费、货架 1% 切片、孤儿推荐佣金、买入侧 0.7% ETH 税，四条管道全部汇入 `ToshLadderTreasury`，只能用于回购销毁（`src/ToshLadderTreasury.sol:23-29`）。

---

## 2. 系统架构与角色定义

### 2.1 四个合约的职责边界

```
                        ┌─────────────────────────────────────────┐
                        │           平台单例（每链一份）            │
                        └─────────────────────────────────────────┘

   ┌──────────────────────────┐   setFactory(一次性)   ┌───────────────────────────────┐
   │      ToshFactory         │──────────────────────▶│    ToshLadderTreasury         │
   │  Ownable2Step + Pausable │                       │      Ownable2Step             │
   │  + ReentrancyGuard       │◀──registeredHooks()───│  （单向阀 / 回购执行器）        │
   │                          │◀──tokenToHook()───────│                               │
   │ · createLaunch (CREATE2) │                       │ · receive() 收四条管道的 ETH   │
   │ · registerPoG (签名配额)  │   launchFee(0.1 ETH)   │ · addLadderToken 策展(owner)   │
   │ · deposit 创世网关        │──────────────────────▶│ · autoPiggybackBuyback(onlyHook)│
   │ · globalReferrers 推荐图  │                       │ · pokeBuyback() 无许可          │
   │ · 黑名单 / 冷却 / 暂停    │                       │ · unlockCallback → _runPiggyback│
   │                          │                       │ · _buyAndBurn → 0xdead         │
   │                          │                       │ · piggybackActive() 瞬态锁      │
   └──────────┬───────────────┘                       └───────────┬───────────────────┘
              │ CREATE2 克隆（EIP-1167，121 字节）                   │ swap/settle/take
              │ + initializeToken                                  │（借帧或自开 unlock）
              ▼                                                    ▼
   ┌──────────────────────────────────────────────────┐   ┌──────────────────────┐
   │            ToshLaunchpadHook（每项目一份）         │──▶│  Uniswap V4          │
   │            IHooks + IUnlockCallback              │◀──│  PoolManager         │
   │                                                  │   │  （ETH / TOKEN 池）   │
   │  Phase 1 · deposit / refund / launch             │   └──────────────────────┘
   │  Phase 2 · mintBondingCurve / quoteMint          │            ▲
   │            claimGenesis / claimReferralReward    │            │ 0.30% 池子费
   │  Hook 回调 · beforeInitialize / beforeSwap        │            │ 归 LP（含散户）
   │             afterSwap / beforeRemoveLiquidity     │            │
   │  Hook 本地 TWAP 预言机（V4 core 不带观测缓冲）      │            │
   └──────────┬───────────────────────────────────────┘            │
              │ mint()（唯一 MINTER_ROLE）                          │
              ▼                                                    │
   ┌──────────────────────────────────────────────────┐            │
   │            ToshToken（每项目一份）                 │────────────┘
   │            ERC20 + AccessControl                 │
   │  MAX_SUPPLY = 21,000,000e18（mint 时硬校验）       │
   │  DEFAULT_ADMIN_ROLE 永久空缺 → 无人能改角色         │
   └──────────────────────────────────────────────────┘

   辅助库（无状态）：
   · src/libraries/HookDeployLib.sol —— 被工厂 DELEGATECALL，隔离 hook creationCode
     以让工厂留在 EIP-170 的 24KB 之内；提供 deployHook / computeInitcodeHash
   · src/libraries/HookMiner.sol     —— CREATE2 地址预测 + V4 掩码校验（REQUIRED_FLAGS = 0x20CC）
```

**关键调用关系（按时间顺序）**

| 序 | 调用方 → 被调方 | 函数 | 说明 | 行号 |
|---|---|---|---|---|
| 1 | 部署者 → Treasury | `constructor` | 必须先于工厂部署（工厂把它当 immutable 构造参数） | `script/Deploy.s.sol:51` |
| 2 | 部署者 → Factory | `constructor(poolManager, pogSigner, platformTreasury, ladderTreasury)` | 同时算出 `HOOK_CREATION_CODEHASH` | `src/ToshFactory.sol` |
| 3 | owner → Treasury | `setFactory` | **一次性**，闭环。未闭环则所有回购静默失效 | `src/ToshLadderTreasury.sol` |
| 4 | creator → Factory | `createLaunch{value: fee}` | CREATE2 部署 hook → `new ToshToken` → `token.initialize(hook)` → `hook.initializeToken(token)` | `src/ToshFactory.sol` |
| 5 | 储户 → Factory → Hook | `deposit{value}` → `hook.deposit(user, boundReferrer)` | 资格校验全在工厂，记账全在 hook | `src/ToshFactory.sol` → `src/ToshLaunchpadHook.sol` |
| 6 | creator → Hook → PoolManager | `launch()` → `initialize` + `unlock` → `unlockCallback` → `modifyLiquidity` | 建池 + 注入全区间创世流动性 | `launch` / `_addInitialLiquidity` @ `src/ToshLaunchpadHook.sol` |
| 7 | 任意交易者 → PoolManager → Hook | `beforeSwap` / `afterSwap` | 抽税 + 写预言机 + 顺风车 poke | `beforeSwap` / `afterSwap` @ `src/ToshLaunchpadHook.sol` |
| 8 | Hook → Treasury | `autoPiggybackBuyback{gas: avail - TAIL_RESERVE}()`（`try/catch` 包裹，且 `gasleft() >= PIGGYBACK_MIN_GAS` 才发起） | 故障隔离 + gas 隔离：国库炸了不能让交易炸，回购贵了也不能让交易 OOG（8.32） | `afterSwap` @ `src/ToshLaunchpadHook.sol` |
| 8b | **任意地址 → Treasury** | `pokeBuyback()` → `poolManager.unlock("")` → `unlockCallback` | 无许可活性兵底。第 8 步的 gas 门控意味着交易不再保证清空储备，这是唯一不依赖 swap 的出口 | `pokeBuyback` @ `src/ToshLadderTreasury.sol` |
| 9 | Treasury → PoolManager | `swap` / `sync` / `settle` / `take` | 顺风车路径**不调 `unlock`**（已在别人帧内）；`pokeBuyback` 路径**自己开帧**，因为没有 swap 可借 | `_buyAndBurn` @ `src/ToshLadderTreasury.sol` |
| 10 | Treasury → Factory | `registeredHooks` / `tokenToHook` | 认证 poke 来源；校验策展代币来源 | `onlyHook` / `addLadderToken` @ `src/ToshLadderTreasury.sol` |
| 11 | Treasury → Hook | `getPoolKey()` / `launched()` | 回购场地从 hook 反查，**不由 owner 提供**；`launched()` 是存储打包后判断项目是否已开盘的唯一可靠依据 | `addLadderToken` @ `src/ToshLadderTreasury.sol` |

### 2.2 角色权限清单

#### 2.2.1 平台 owner（`ToshFactory` + `ToshLadderTreasury`，Ownable2Step）

| 能做 | 函数 | 约束 | 行号 |
|---|---|---|---|
| 暂停 / 恢复工厂 | `pause` / `unpause` | **只影响 `createLaunch` 与 `registerPoG` 两个入口**。`deposit` 没有 `whenNotPaused`——已开启的创世轮次照常收款（⚠️ 8.12） | `src/ToshFactory.sol` |
| 停售 / 恢复阶梯 | `haltLadderMinting` / `resumeLadderMinting` | **唯一能触及已开盘项目的刹车**，且只触及 `mintBondingCurve`。单次 `≤ MAX_HALT_DURATION = 7 days` 且自动失效（`HaltDurationTooLong`）；`hook == address(0)` 停全部，否则只停该项目。不影响 swap / LP / `claimGenesis` / `claimReferralReward` / `refund`——**能让买家损失机会，不能让任何人损失余额**。见 §11 D3 | `src/ToshFactory.sol` `haltLadderMinting` |
| 轮换 PoG 签名者 | `setPogSigner` | 非零 | `src/ToshFactory.sol` |
| 轮换 `platformTreasury` | `setPlatformTreasury` | 非零；但该地址无任何资金流（⚠️ 8.2） | `src/ToshFactory.sol` |
| 调整发射费 | `setLaunchFee` | 允许为 0；受调用方 `expectedFee` 滑点保护 | `src/ToshFactory.sol` |
| 调整冷却期 | `setCooldownDuration` | `≤ MAX_COOLDOWN = 7 days`；为 0 时 PoG 额度退化为终身预算（⚠️ 8.25） | `src/ToshFactory.sol` |
| 调整默认软顶 | `setDefaultSoftCap` | `≥ MIN_SOFT_CAP_PROD = 0.01 ether`，防 `p0` 截断为 0 | `src/ToshFactory.sol` |
| 调整每钱包上限 | `setMaxPogAllocationLimit` | **必须非零**（`InvalidPogLimit`）；只影响之后创建的项目。该值会快照进每个新 hook 的构造函数，而构造函数要求 `_perWalletCap > 0`，所以归零会让全站 `createLaunch` 以 `DeployFailed` 报废——停止接项目请用 `pause()`（见 §8.27） | `src/ToshFactory.sol` `setMaxPogAllocationLimit` |
| 批量拉黑 / 解禁 | `setBlacklist` / `liftBlacklist` | 每批 ≤ 200；`banDuration == type(uint256).max` 为永久 | `src/ToshFactory.sol` |
| 策展回购阶梯 | `addLadderToken` / `removeLadderToken` | 代币必须经本平台 `tokenToHook` 注册且已开盘 | `src/ToshLadderTreasury.sol` |
| 绑定国库↔工厂 | `setFactory` | 一次性，不可重指 | `src/ToshLadderTreasury.sol` |

| **不能做** | 原因 |
|---|---|
| 从国库取走任何 ETH | 国库无 `withdraw`/`sweep`/`rescue`/`delegatecall`；唯一出金 `_buyAndBurn` 收款方硬编码 `0xdead`（`src/ToshLadderTreasury.sol:37-51`）。测试 `test_ladderTreasury_hasNoWithdrawPath` @ `test/ToshV5.t.sol` |
| 把回购资金导向自己控盘的池子 | `addLadderToken` 只收本平台已开盘代币，池子 key 从 hook 反查（`src/ToshLadderTreasury.sol`）。测试 `test_ladderTreasury_ownerCannotRedirectSpendToOwnPool` @ `test/ToshV5.t.sol` |
| 改动已开盘项目的经济参数 | `softCap` / `perWalletCap` / `genesisDuration` 都是 hook 的 immutable，创建时快照（`src/ToshLaunchpadHook.sol`）。测试 `test_setDefaultSoftCap_doesNotAffectExistingHooks` @ `test/ToshV5Factory.t.sol` |
| 改 `ToshToken` 的角色 | `DEFAULT_ADMIN_ROLE` 从未授予任何人，`grantRole`/`revokeRole` 永久不可用（`constructor` / `initialize` @ `src/ToshToken.sol`） |
| **阻止**某一次回购 | `autoPiggybackBuyback` 只接受注册 hook 调用（`onlyHook`），owner 直接调会 revert `OnlyHook`；而 `pokeBuyback()` 无许可，owner 拦不住任何人触发。测试 `test_autoPiggybackBuyback_rejectsNonHookCallers` @ `test/ToshV5.t.sol` |
| 暂停已开盘项目的**交易**（swap / LP / 领取 / 退款） | 无任何开关可达（⚠️ 8.12） |

#### 2.2.2 项目创作者（creator）

- **是**：`createLaunch` 的 `msg.sender`，被写入 hook 的 `creator` immutable（`src/ToshLaunchpadHook.sol`）。
- **唯一专属权限**：调用 `launch()` 开盘（`src/ToshLaunchpadHook.sol`，`OnlyCreator`）。
- **不能**：改 `projectAdmin`（那是 `projectAdmin` 自己的权限）、不能提前开盘（必须 `block.timestamp >= genesisDeadline`，⚠️ 8.7）、不能退款给自己、不能移除创世流动性。
- 参与 CREATE2 盐派生：`finalSalt = keccak256(abi.encode(msg.sender, hookSalt))`（`createLaunch` @ `src/ToshFactory.sol`），所以**盐是创作者绑定的**，别人挖到的盐在你身上无效。

#### 2.2.3 项目管理员（projectAdmin）

| 能做 | 函数 | 行号 |
|---|---|---|
| 领取 Phase-2 货架收入的 99% | 被动接收（`mintBondingCurve` 内 `_sendEth`） | `src/ToshLaunchpadHook.sol` |
| 把角色移交给新钱包 / 多签 | `changeProjectAdmin(newAdmin)` | `src/ToshLaunchpadHook.sol` |

- **不能**：铸造代币（唯一 `MINTER_ROLE` 是 hook 自己）、动创世 ETH、动创世 LP、开盘。
- 是 hook 里**唯一可变的**资金收款地址（其他都是 immutable）。

#### 2.2.4 项目金库（projectTreasury）

- 构造参数、`require` 非零、写入 immutable（`constructor` / `projectTreasury` @ `src/ToshLaunchpadHook.sol`）。
- **⚠️ 8.1：合约里没有任何一处向 `projectTreasury` 转账或读取它。** 它的全部作用是（a）作为 CREATE2 initcode 元组的一员从而影响 hook 地址，（b）作为链上可读的"项目多签"元数据。前端把它硬绑为创作者的连接钱包并设为只读（`soat-frontend/src/app/launch/page.tsx:468`、`622-629`）。

#### 2.2.5 平台金库（platformTreasury）

- 工厂的可变 owner 状态（`platformTreasury` / `setPlatformTreasury` @ `src/ToshFactory.sol`）。
- **⚠️ 8.2：没有任何资金流向它。** 发射费走 `ladderTreasury`（`createLaunch` @ `src/ToshFactory.sol`），Phase-2 的 1% 平台切片也走 `ladderTreasury`（`mintBondingCurve` @ `src/ToshLaunchpadHook.sol`）。`platformTreasury` 在代码里只被 `getLiveHookInitcodeHash` 当作哨兵地址填充占位（`src/ToshFactory.sol`）。

#### 2.2.6 创世储户

| 能做 | 何时 | 函数 | 行号 |
|---|---|---|---|
| 出资 | 创世窗口内、有 PoG 额度、未拉黑、未冷却、未超每钱包上限 | `factory.deposit{value}(hook, referrer)` | `src/ToshFactory.sol` |
| 100% 退款 | 软顶未达成，或超 7 天僵尸窗口 | `hook.refund()` | `src/ToshLaunchpadHook.sol` |
| 按出资比例认领 4,620,000 枚中的份额 | 开盘后，一次性 | `hook.claimGenesis()` | `src/ToshLaunchpadHook.sol` |

- **不能**：多次认领（`genesisShareClaimed` 布尔位）、退款后再认领（`refund` 要求 `!launched`，两条路径互斥）、在开盘后退款。

#### 2.2.7 二级交易者

- 在 V4 池子上正常 swap。每笔付 **1.00%** 摩擦：0.30% `POOL_FEE` 归 LP（V4 原生结算），0.70% `TAX_BPS` 归协议（`POOL_FEE` / `TAX_BPS` @ `src/ToshLaunchpadHook.sol`）。
- 无白名单、无额度、无冷却、无黑名单——池子层面完全开放（黑名单只作用于 `factory.deposit`）。

#### 2.2.8 推荐人

- 绑定关系写在工厂的 `globalReferrers`，**全平台、终身、只写一次**（`ToshFactory.globalReferrers` / `_recordReferral`）。
- **四条**静默拒绝路径（不 revert，避免链接失效造成拒绝服务；被拒的绑定不等于被拒的出资，佣金落进 `orphanReferral` 变回购燃料）：已绑定 / 推荐人为零地址 / 自我推荐 / **推荐人自身没有 PoG 额度**（`ToshFactory._recordReferral`）。
- 最后一条是 v5.0 后期补的反女巫措施。`referrer != user` 只有一个地址的深度，换个自己的小号就能把每笔出资的 10% 拿回来，而那个小号原本不需要额度、不需要出资、不需要任何历史。要求 `pogQuota[referrer] > 0` **挡不住**铁了心的女巫（链上做不到），它做的是把判断挪到唯一能判断的地方——PoG 预言机：每个小号得先过一次和出资人相同的认证，签名方可以在链下定价、限流或拒签。这是一道成本，不是一堵墙（见 §8.28）。测试 `test_probeJ_referralSelfFarmViaSecondWallet`。
- 佣金 = 被推荐人每次创世出资的 10%，在 `deposit` 时即计入 `referralAccrued`，开盘后可提（`deposit` / `claimReferralReward` @ `src/ToshLaunchpadHook.sol`）。
- **失败的创世不欠推荐人任何东西**：退款返 100%，佣金只在 `launch()` 时才真正兑现，`referralAccrued` 单纯变成永不可领（`refund` @ `src/ToshLaunchpadHook.sol`）。

#### 2.2.9 散户 LP

- 用**自己的**（或所经由的 router/posm 的）V4 仓位，自由 `modifyLiquidity` 增减（`beforeRemoveLiquidity` @ `src/ToshLaunchpadHook.sol`）。
- 赚 0.30% 池子费，由 V4 原生计入仓位，Tosh 无分配代码。
- **不能**碰创世仓位：V4 把仓位按 `msg.sender` 归属，创世仓位归 hook，而 hook 的 `unlockCallback` 只认 `ACTION_ADD_LIQUIDITY`（`unlockCallback` @ `src/ToshLaunchpadHook.sol`）。测试 `test_genesisLiquidityIsPermanentlyLocked` @ `test/ToshV5.t.sol`。

---

## 3. 代币经济与资产流模型

### 3.1 供应切分

| 层级 | 常量 | 数量 | 占 21M | 用途 | 行号 |
|---|---|---|---|---|---|
| 硬顶 | `ToshToken.MAX_SUPPLY` | 21,000,000e18 | 100% | `mint` 时逐笔校验 | `src/ToshToken.sol` |
| 创世块 | `GENESIS_SUPPLY` | 8,400,000e18 | 40% | 开盘时一次性铸给 hook | `src/ToshLaunchpadHook.sol` |
| ├ 认领侧 | `GENESIS_CLAIM_SUPPLY` | 4,620,000e18 | 22%（创世块的 **55%**） | 储户按出资比例认领 | `src/ToshLaunchpadHook.sol` |
| └ 底池侧 | `GENESIS_LP_SUPPLY` | 3,780,000e18 | 18%（创世块的 **45%**） | 全区间注入底池并永久锁定 | `src/ToshLaunchpadHook.sol` |
| Phase-2 阶梯 | `BONDING_MAX = TIER_COUNT × TIER_SIZE` | 12,600,000e18 | 60% | 4000 档 × 3,150 枚 | `src/ToshLaunchpadHook.sol` |

算术闭合：8,400,000 + 12,600,000 = 21,000,000，精确等于硬顶。测试 `test_supplyPartitioning` @ `test/ToshV5Guards.t.sol`。

**40 / 60 而不是 20 / 80，是压制早期通胀的主控旋钮。** 等量货架在市价 `R×` 时释放 `log(R)/log(SPAN)` **比例**的 Phase-2，这个比例只取决于跨度，与 Phase-2 有多大无关。所以要减少上涨途中砸向市场的**绝对枚数**，唯一办法就是把 Phase-2 本身做小，把差额交给创世块——那部分供应在开盘时就已定价、已流通，不构成新增卖压。三代配置在 2× 这个点上的对比：

| 配置 | 2× 时放出 | 占 `GENESIS_SUPPLY` |
|---|---|---|
| 20/80 + 1000× 跨度 | 1,688,400 | 40.2% |
| 20/80 + 2000× 跨度 | 1,533,000 | 36.5% |
| **40/60 + 2000× 跨度（当前）** | **1,149,750** | **13.7%** |

**⚠️ 注意这个分母。** `GENESIS_SUPPLY` 是 8.4M，但其中 **3.78M 永久封在创世 LP 仓位里**——hook 持有该仓位且没有任何移除流动性的代码路径——那是存在但永不交易的供应。上表的百分比适合横向比较三种**配置**，不适合回答"市场要吃下多少"。换成真正的可交易盘：

| 2× 时的分母 | 枚数 | 占比 |
|---|---|---|
| `GENESIS_SUPPLY`（8.4M，含锁定 LP） | 1,149,750 | 13.7% |
| 认领盘 4.62M —— 真正会交易的那部分 | 1,149,750 | **24.9%** |
| 释放后总流通盘（4.62M + 1.15M） | 1,149,750 | **19.9%** |

所以 40/60 相对 20/80 是真实的改进（36.5% → 13.7% 是同口径比较），但市价翻倍时市场仍要吸收**约五分之一到四分之一的活跃流通盘**。若 ~10% 流通盘是硬目标，跨度或切分还得继续动（见 §11 待决策 D1）。

由 `test_earlyReleaseSchedule_isSetByTheSupplySplit` @ `test/ToshV5.t.sol` 钉住：2× 精确解锁 365 档 = 1,149,750 枚，**三个口径同时断言**，动任何一个旋钮都必须重新说明另外两个——一个改善了头条数字却恶化了流通盘数字的改动会在这里失败而不是上线。

10% 开盘溢价**不受影响**：它由 55 : 45 这个**比例**对上 10% 推荐佣金决定（`(0.9 / 3.78) × 4.62 = 1.10`），与创世块的绝对大小无关。

> **⚠️ 8.16**：`ToshToken` 的注释仍说 Phase-2 "asymptotic to BONDING_MAX … converges to (but never reaches) MAX_SUPPLY"。那是 v4.0 切线曲线的性质。v5.0 的离散阶梯 **4000 × 3,150 = 12.6M 精确可清空**，所以总供应是**可以真正到达** 21M 的。（注释已随本次改动一并修正。）

### 3.2 资金流：创世募集 → 底池

```
  储户出资总额  R  =  totalEthDeposition
        │
        ├─── 10%（REFERRAL_BPS = 1000）在 deposit 时逐笔切出
        │      ├── 有推荐人 → referralAccrued[referrer] += 10%（开盘后可提）
        │      └── 无推荐人 → orphanReferral += 10%
        │                        └── launch() 时全额转入 ladderTreasury（回购弹药）
        │
        └─── 90%  =  lpEth  =  R − (totalReferralReserved + orphanReferral)
                 │
                 └── 与 GENESIS_LP_SUPPLY (3.78M) 一起全区间注入 V4 底池，永久锁定
```

代码位置：切佣 `deposit`；`lpEth` 计算与孤儿佣金转出 `launch`；建池注入 `_addInitialLiquidity`——均在 `src/ToshLaunchpadHook.sol`。测试 `test_orphanReferralIsForwardedToLadderTreasuryAtLaunch` @ `test/ToshV5.t.sol`。

**关键点**：无论有没有推荐人，从底池的角度看**永远只有 90% 进池**。这是让 10% 溢价成为结构性常量（而不是随推荐率浮动）的前提。

### 3.3 定价：p0、shelfP0 与 10% 溢价的来源

```
p0      = lpEth × 1e18 / GENESIS_LP_SUPPLY            // launch() @ src/ToshLaunchpadHook.sol
shelfP0 = p0 × SHELF_PREMIUM_BPS / 10000
        = p0 × 10500 / 10000
        = p0 × 1.05                                    // launch() @ src/ToshLaunchpadHook.sol
```

**10% 溢价的数学推导**（合约注释里已给出，`GENESIS_CLAIM_SUPPLY` / `GENESIS_LP_SUPPLY` @ `src/ToshLaunchpadHook.sol`）：

```
储户成本基准   P_raise = R / GENESIS_CLAIM_SUPPLY = R / 4,620,000
底池开盘价     p0      = 0.9R / GENESIS_LP_SUPPLY  = 0.9R / 3,780,000

p0 / P_raise = (0.9 / 1.89) × 2.31 = 1.10   （精确）
```

也就是：**55/45 的切分 + 10% 推荐率，三者共同决定了这个 1.10**。动任何一个，溢价就变。测试用 `assertApproxEqRel(…, 1e12)` 把这个**关系**（而非硬编码价格）钉住，并同时校验 `shelfP0 = 1.155 × 成本基准`（`test_genesisPremium_isExactlyTenPercent` @ `test/ToshV5.t.sol`）。

**为什么货架要再高 5%**（`SHELF_PREMIUM_BPS` / `PRICE_CEILING_BPS` @ `src/ToshLaunchpadHook.sol`）：

- `SHELF_PREMIUM_BPS` 被**故意设成等于** `PRICE_CEILING_BPS`（都是 10500）。于是门控条件 `shelfP0 · STEP^i ≤ REF × 1.05` 里的 1.05 两边对消，坍缩成：

  ```
  货架 i 解锁  ⟺  REF ≥ p0 · STEP^i
  （REF = 窗口成熟后的 min(spot, TWAP)；未成熟时为 min(spot, p0)）
  ```

- 三个后果：
  1. **开盘瞬间 Phase-2 完全关闭**。开盘时 `spot == p0` 精确落在边界上（`tierPriceAt(0) = 1.05·p0 > 1.05·p0` 不成立，但等号成立时 `≤` 通过——实测 `maxMintable() == 0`，见 `test_ladderOpensLockedAtLaunch` @ `test/ToshV5.t.sol`）。若货架与池子齐平，开盘那一刻货架 0..14（126,000 枚）就是可铸的。
  2. **铸币砸盘在整条阶梯上都亏钱**，因为买家永远比市价高付 5%（测试 `test_sweepAndDumpIsLossMaking` @ `test/ToshV5.t.sol`，断言亏损 > 成本的 5%）。
  3. 叠加创世溢价后货架 0 = 储户成本 × 1.155，Phase-2 增发永不砸穿创世储户的成本线。

  > **⚠️ 8.9**：这个"对消"意味着货架实际是**紧贴市价**解锁，而不是"必须高于市价 5% 才解锁"。名义上的 5% 是铸造溢价（相对同一时点市价），不是解锁缓冲。它保护的是"铸了立刻砸"的即时套利，**不保护**"市价先涨、低档货架变成深度价内"的滞后套利（见 5.6）。

### 3.4 阶梯几何

| 参数 | 值 | 含义 | 行号 |
|---|---|---|---|
| `TIER_COUNT` | 4000 | 档数 | `src/ToshLaunchpadHook.sol` |
| `TIER_SIZE` | 3,150e18 | 每档配额（4000 × 3,150 = 12.6M） | `src/ToshLaunchpadHook.sol` |
| `TIER_STEP_E18` | `1_001_902_508_266_805_824` | 步进（1e18 定点） | `src/ToshLaunchpadHook.sol` |
| 每档涨幅 | +0.19025% | `STEP − 1` | 同上 |
| 全程跨度 | ≈ 2000× | `STEP^3999 ≈ 2000` | `src/ToshLaunchpadHook.sol` |
| 求值方式 | `tierPriceAt(i) = mulDiv(shelfP0, STEP^i, 1e18)`，快速幂 O(log i) | 顶档约 12 组 `mulDiv`，而非 3999 次累乘 | `src/ToshLaunchpadHook.sol` |
| 单次跨档上限 | `MAX_TIERS_PER_TX = 32` | **gas 上限，非安全上限**；按 `ln(1.05)/ln(STEP) ≈ 25.7` 定档，让 105% 天花板而不是腿数成为绑定约束 | `src/ToshLaunchpadHook.sol` |

**跨度为什么是 2000× 而不是 1000×**：等量货架的放量是 `log(R)/log(SPAN)`——市价到 `SPAN^x` 才解锁 `x` **比例**的阶梯。跨度是唯一一个不动供应切分就能压低早期通胀的旋钮，但它被对数压得很平：分母从 `ln 1000 = 6.91` 变成 `ln 2000 = 7.60`，只买到约 9% 的改善。真正的重活由 40 / 60 供应切分承担（见 3.1），跨度只是在其上再修一刀。

当前配置（4000 档 × 3,150 枚，2000× 跨度）的放量时间表：

| 市价 | 解锁档 | 放出枚数 | 占创世 8.4M | 占阶梯 12.6M | **占认领盘 4.62M** |
|---|---|---|---|---|---|
| 1.2× | 96 | 302,400 | 3.6% | 2.4% | 6.5% |
| 1.5× | 214 | 674,100 | 8.0% | 5.4% | 14.6% |
| **2×** | 365 | **1,149,750** | **13.7%** | 9.1% | **24.9%** |
| 3× | 579 | 1,823,850 | 21.7% | 14.5% | 39.5% |
| 5× | 848 | 2,671,200 | 31.8% | 21.2% | 57.8% |
| 10× | 1213 | 3,820,950 | 45.5% | 30.3% | 82.7% |
| 100× | 2425 | 7,638,750 | 90.9% | 60.6% | 165.3% |
| 2000× | 4000 | 12,600,000 | 150.0% | 100.0% | 272.7% |

最后一列是唯一回答"谁来接盘"的口径：另外两列的分母都含有不交易的供应（8.4M 里锁着 3.78M 的 LP；12.6M 是尚未铸出的阶梯本身）。

**要把早期放量再压一个数量级，跨度这个旋钮做不到**——剩下的手段是让每档配额随价格几何增长（`size(i) ∝ SIZE_STEP^i`，2× 时可压到创世盘的个位数百分比）。该方案会让低价区单笔可买量降到当前的 1/4 左右，评估后暂未采纳。

**为什么步进与档数耦合**：注释明确说明 `STEP = 1000^(1/1999)`，两者必须一起改。且跨度不能任意拉高——`1.2^1999 ≈ 1e158` 会在阶梯清空前就溢出 `uint256`（`TIER_STEP_E18` @ `src/ToshLaunchpadHook.sol`）。

**为什么价格不落盘**：4000 档物化成 storage 结构体要花掉数百万 gas；而"缓存当前价 + 累乘推进"经过 4000 次截断会与闭式解漂移。所以 `tierPriceAt()` 是铸造热路径、`quoteMint`、以及所有 view 的**唯一价格来源**（`tierPriceAt` @ `src/ToshLaunchpadHook.sol`）。`getTiers()` 分页 view 也逐档重算而不是向前走序列，理由是"显示价与成交价差 1 wei 就是一张客服工单"（`getTiers` @ `src/ToshLaunchpadHook.sol`）。

### 3.5 费率总表

| 费用 | 常量 | 值 | 来源侧 | 去向 | 行号 |
|---|---|---|---|---|---|
| 发射费 | `ToshFactory.launchFee` | 0.1 ETH（默认，owner 可调，可为 0） | creator | `ladderTreasury`（回购弹药） | `launchFee` / `createLaunch` @ `src/ToshFactory.sol` |
| 推荐佣金 | `REFERRAL_BPS` | 10%（1000 bps） | 每笔创世出资 | 推荐人；无推荐人→`ladderTreasury` | `REFERRAL_BPS` / `deposit` @ `src/ToshLaunchpadHook.sol` |
| Phase-2 平台切片 | `PLATFORM_TAX_BPS` | **1%**（100 bps） | 货架成交额 | `ladderTreasury` | `PLATFORM_TAX_BPS` / `mintBondingCurve` @ `src/ToshLaunchpadHook.sol` |
| Phase-2 项目切片 | 余额 | **99%** | 货架成交额 | `projectAdmin` | `mintBondingCurve` @ `src/ToshLaunchpadHook.sol` |
| 交易税（协议） | `TAX_BPS` | **0.70%**（70 bps） | 每笔 swap 的 **input**（按买/卖方向，不按 specified 币种） | 买单 ETH→`ladderTreasury`；卖单代币→`0xdead` | `TAX_BPS` / `beforeSwap` / `afterSwap` @ `src/ToshLaunchpadHook.sol` |
| 池子费（LP） | `POOL_FEE` | **0.30%**（3000，V4 单位） | 每笔 swap | LP（V4 原生结算，Tosh 无代码） | `POOL_FEE` @ `src/ToshLaunchpadHook.sol` |
| **交易者总摩擦** | — | **1.00%** | — | 0.30 给 LP + 0.70 给协议 | `POOL_FEE` / `TAX_BPS` @ `src/ToshLaunchpadHook.sol` |

**v4.x → v5.0 的摩擦重分配**：v4.x 收 1% 池子费 + 1% 税 = 2%，而池子费那一半是死重（唯一 LP 是永久锁定的创世仓位，没人能领）。v5.0 把总摩擦砍回 1.00%，并让池子费真正有了领取人（`src/ToshLaunchpadHook.sol:73-84`）。

**交易税按买卖方向抽 input，不按 specified 侧币种。** exact-input 在 `beforeSwap` 结算；exact-output 在 `afterSwap` 对 unspecified input 补齐 Delta（掩码含 `AFTER_SWAP_RETURNS_DELTA`）。

| 交易形态 | `amountSpecified` | `zeroForOne` | 抽哪一侧 | 去向 | 回调 |
|---|---|---|---|---|---|
| 买（exact-input） | 负 | true | ETH input | `ladderTreasury` | `beforeSwap` |
| 卖（exact-input） | 负 | false | 代币 input | `0xdead` | `beforeSwap` |
| 买（exact-output） | 正 | true | ETH input | `ladderTreasury` | `afterSwap` |
| 卖（exact-output） | 正 | false | 代币 input | `0xdead` | `afterSwap` |

这样聚合器把买单全部构造成 "N tokens out" 也无法让国库收 0 ETH。测试：`test_buyTax_skimsSeventyBpsEthToLadderTreasury`、`test_sellTax_burnsSeventyBpsOfTokensInPlace`、`test_buyTax_exactOutputSkimsEthNotTokens`、`test_sellTax_exactOutputBurnsTokensNotEth`。

### 3.6 国库的四条进水管

`src/ToshLadderTreasury.sol:23-29` 明确列出：

1. 每个 Tosh 池的**买入侧 0.7% ETH 税**；
2. `ToshFactory` 的**项目发射费**；
3. **孤儿推荐佣金**（无推荐人的出资的 10%）；
4. 每笔货架铸造的 **1% 平台切片**。

卖出侧的税**永远不到这里**——那些代币被 hook 就地销毁，不需要任何储备（`src/ToshLadderTreasury.sol:28-29`）。

---

## 4. 产品全生命周期与业务流程

### 4.1 状态机总览

| 状态 | 判据（链上） | 可用操作 | 转出条件 |
|---|---|---|---|
| **S0 未创建** | — | `createLaunch` | 部署成功 |
| **S1 创世募集中** | `!launched && block.timestamp < genesisDeadline` | `deposit` | 到达 `genesisDeadline` |
| **S2 待开盘** | `!launched && ts ≥ genesisDeadline && total ≥ softCap && ts ≤ deadline+7d` | `launch()`（creator） | `launch()` 成功 → S4；超 7 天 → S3b |
| **S3a 创世失败** | `!launched && ts > genesisDeadline && total < softCap` | `refund()` | 终态 |
| **S3b 僵尸超时** | `!launched && ts > genesisDeadline + LAUNCH_WINDOW(7d)` | `refund()` | 终态（`launch()` 此后 revert `LaunchWindowExpired`） |
| **S4 已开盘 / 阶梯运行** | `launched == true` | `claimGenesis` / `claimReferralReward` / `mintBondingCurve` / 池子 swap / 散户 LP | `currentTierIndex == TIER_COUNT` → S5 |
| **S5 阶梯耗尽** | `currentTierIndex >= TIER_COUNT` | 池子 swap / 散户 LP（`mintBondingCurve` revert `LadderExhausted`） | 终态 |

判据代码：`canRefund()`、`launch()` 的前置检查、`refund()` 的前置检查——三者均在 `src/ToshLaunchpadHook.sol`。

> **⚠️ 8.13**：`refundEnabled` / `zombieRefundEnabled` 两个状态位在 `refund()` 里被懒惰置位并发事件（`src/ToshLaunchpadHook.sol`），但**从未被任何地方读作门控条件**。真正的门控是每次调用时重算 `softCapFailed || zombieExpired`。它们是纯事件标记位。

### 4.2 创建发射 —— `createLaunch`

**签名**（`src/ToshFactory.sol`）：

```solidity
function createLaunch(
    string calldata name,
    string calldata symbol,
    address projectTreasury,
    address projectAdmin,
    bytes32 hookSalt,
    uint256 expectedFee,
    uint256 genesisDuration
) external payable whenNotPaused nonReentrant returns (address token, address hook)
```

**执行顺序**：

| 步 | 动作 | 失败错误 | 行号 |
|---|---|---|---|
| 1 | `projectTreasury != 0`、`projectAdmin != 0` | `"zero treasury"` / `InvalidAdmin` | 355-356 |
| 2 | 费用滑点保护：`launchFee > expectedFee` 则拒绝 | `FeeChanged` | 358-359 |
| 3 | `msg.value >= fee` | `InsufficientLaunchFee` | 360 |
| 4 | 名称/符号非空 | `EmptyName` | 363 |
| 5 | **(name, symbol) 元组未被占用**：`nameKey = keccak256(abi.encode(name, symbol))` | `NameTaken` | 364-365 |
| 6 | 派生创作者绑定盐 `finalSalt = keccak256(abi.encode(msg.sender, hookSalt))` | — | 367 |
| 7 | **冻结两个平台旋钮**进 initcode：`launchSoftCap = defaultSoftCap`、`launchWalletCap = maxPogAllocationLimit` | — | 371-372 |
| 8 | 算 initcode hash（**9 参元组**）并预测地址 | — | 374-385 |
| 9 | **掩码校验**：`HookMiner.isValidHookAddress(predicted)`，要求低 14 位含 `0x20CC` | `InvalidHookSalt` | 386 |
| 10 | `HookDeployLib.deployHook`（CREATE2，delegatecall 到库，部署者是工厂） | `DeployFailed` | 388-400 |
| 11 | `new ToshToken(name, symbol, factory)` → `token.initialize(hook)`（授 `MINTER_ROLE`）→ `hook.initializeToken(token)` | — | 402-404 |
| 12 | 登记：`registeredHooks[hook] = true`、`tokenToHook[token] = hook`、`nameTaken[nameKey] = true` | — | 406-408 |
| 13 | 入册 + 发 `LaunchCreated` | — | 410-413 |
| 14 | 发射费转 `ladderTreasury`，多付部分退还 `msg.sender` | `EthTransferFailed` | 416-421 |

**9 参构造元组**（`deployHook` @ `src/libraries/HookDeployLib.sol`，顺序固定）：

```
1. poolManager      (address)   Uniswap V4 PoolManager
2. factoryAddr      (address)   = address(this)（delegatecall 语境下即工厂）
3. projectTreasury  (address)   项目多签元数据
4. creator          (address)   = msg.sender
5. projectAdmin     (address)   99% 货架收入收款方
6. ladderTreasury   (address)   平台回购储备
7. softCap          (uint256)   本项目软顶（快照）
8. perWalletCap     (uint256)   本项目每钱包上限（快照）
9. genesisDuration  (uint256)   创世窗口长度（3h / 24h / 72h 之一）
```

**这 9 个参数全部进 initcode hash**，所以任何一项变化都会让已挖的盐失效。前端为此做了三处缓存失效（见 6.4）。`HookDeployLib` 的注释直接点名：v5.0 删了 `satoToken`、加了 `ladderTreasury` + `perWalletCap`，`genesisDuration` 让它凑到 9 个字段，**所有链下盐矿机必须重新生成**（`src/libraries/HookDeployLib.sol`）。

**CREATE2 掩码 `0x20CC`**（`src/libraries/HookMiner.sol`）：

| 位 | 值 | 标志 | 用途 |
|---|---|---|---|
| 13 | `0x2000` | `BEFORE_INITIALIZE` | 建池抢跑防御（只允许 hook 自己的 `launch()` 建池） |
| 7 | `0x0080` | `BEFORE_SWAP` | exact-input 税 |
| 6 | `0x0040` | `AFTER_SWAP` | 写预言机 + 顺风车 poke + exact-output 税 |
| 3 | `0x0008` | `BEFORE_SWAP_RETURNS_DELTA` | 抽 specified（= input） |
| 2 | `0x0004` | `AFTER_SWAP_RETURNS_DELTA` | 抽 unspecified（= input，exact-output） |
| — | 合计 `0x20CC` | | |

**故意不设**：`BEFORE_REMOVE_LIQUIDITY`（bit 9），让散户 LP 自由撤出。

⚠ 掩码从 `0x2200` → `0x20C8` → `0x20CC`。Solidity 矿机和 TS 矿机必须一致，否则 `createLaunch` revert `InvalidHookSalt`。

### 4.3 Phase 1 —— 创世募集

#### 4.3.1 三档创世时长

| 常量 | 值 | 前端标签 | 定位话术（前端） | 行号 |
|---|---|---|---|---|
| `DURATION_FAST` | 3 hours | "3 Hours / Fast" | "Momentum play — hits the cap fast or fails fast." | `src/ToshLaunchpadHook.sol` |
| `DURATION_STANDARD` | 24 hours | "24 Hours / Standard" | "Covers every timezone once. The default." | `src/ToshLaunchpadHook.sol` |
| `DURATION_SLOW` | 72 hours | "72 Hours / Slow" | "Maximum reach for a wider raise." | `src/ToshLaunchpadHook.sol` |

前端常量镜像 + 文案：`soat-frontend/src/app/lib/hookMiner.ts:41-43`、`soat-frontend/src/app/launch/page.tsx:104-108`。默认值 `GENESIS_DURATION_STANDARD`（`soat-frontend/src/app/launch/page.tsx:411`）。

**为什么是封闭集合而不是自由 `uint256`**（`DURATION_FAST` / `DURATION_STANDARD` / `DURATION_SLOW` @ `src/ToshLaunchpadHook.sol`）：时长是构造元组的一员，因此也是 initcode hash 的一部分。开放区间会让创作者能针对 1 秒窗口（没人来得及存，创世立刻失败，退款即刻打开）或 100 年窗口（存款被锁死且无退款路径）挖盐。三档粗粒度既保留市场意义，也堵住两个退化端。构造函数逐一比对三个常量，否则 revert `InvalidDuration`（`constructor` @ `src/ToshLaunchpadHook.sol`）。测试：`test_hook_ctor_acceptsTheThreeAllowedWindows` 与 `test_hook_ctor_revertsOnUnlistedWindow` @ `test/ToshV5Guards.t.sol`，`test_createLaunch_rejectsSaltMinedForAnotherWindow` @ `test/ToshV5Factory.t.sol`。

#### 4.3.2 PoG（Proof-of-Gas / Goodwill）配额与签名注册

> 注：合约注释里 `registerPoG` 被称为 "Proof-of-Gas"（`registerPoG` @ `src/ToshFactory.sol`），与前端和 README 一致；"Proof of Goodwill" 这个叫法只出现在本文档里，`src/` 中并不存在。

**签名摘要**（`registerPoG` @ `src/ToshFactory.sol`），六元组防重放：

```
digest = toEthSignedMessageHash(keccak256(abi.encode(
    msg.sender,      // 绑定钱包
    maxAlloc,        // 授予的额度（ETH-wei）
    nonce,           // 递增，防重放
    deadline,        // 过期时间
    address(this),   // 绑定工厂
    block.chainid    // 绑定链
)))
require(digest.recover(signature) == pogSigner)
```

**校验顺序**（`registerPoG` @ `src/ToshFactory.sol`）：

| 检查 | 错误 | 说明 |
|---|---|---|
| `deadline ≤ now + MAX_SIG_VALIDITY(24h)` | `SignatureTooLong` | 防长效签名 |
| `now ≤ deadline` | `SignatureExpired` | |
| `nonce == pogNonces[sender]` | `NonceConflict` | 严格顺序，不能跳号 |
| `maxAlloc ≤ maxPogAllocationLimit` | `ExceedsGlobalPogLimit` | **不静默截断**，直接拒（测试 `test_registerPoG_noSilentClamp` @ `test/ToshV5Factory.t.sol`） |
| 签名恢复 == `pogSigner` | `InvalidSignature` | |

**额度只上调不下调**：`if (maxAlloc > pogQuota[sender]) pogQuota[sender] = maxAlloc;`（`registerPoG` @ `src/ToshFactory.sol`）。⚠️ **8.10**：owner 事后调低 `maxPogAllocationLimit` **不会**回收已注册的额度。

⚠️ **8.11**：`registerPoG` 有 `whenNotPaused` 但**没有黑名单检查**。被拉黑的钱包仍可注册/提升 PoG 额度（只是 `deposit` 会被 `IsBlacklisted` 拦住）。

**配额窗口机制**（`quotaWindowEnd` / `quotaSpent` / `_rollQuotaWindow` @ `src/ToshFactory.sol`）：

- PoG 额度是**冷却期预算**，不是终身预算：一个钱包在每个 `cooldownDuration` 窗口内可花掉最多 `pogQuota`，窗口过期后归零重开。
- **退款不返还窗口额度**——刻意的：撤资就该失去这一轮的名额，否则「存入-退款」循环能无限复用一个钱包的额度（`quotaSpent` @ `src/ToshFactory.sol`）。测试 `test_pogQuota_isNotRestoredByRefund` @ `test/ToshV5.t.sol`。
- ⚠️ **8.25**：`cooldownDuration == 0` 时 `_rollQuotaWindow` 直接返回 `quotaSpent`，额度退化成**终身预算**（`src/ToshFactory.sol:584-593`）。冷却期长度与额度窗口长度是同一个旋钮，存在耦合。

#### 4.3.3 出资 `deposit`

**工厂侧关卡**（`src/ToshFactory.sol:442-468`，顺序即执行顺序）：

| # | 检查 | 错误 |
|---|---|---|
| 1 | `msg.value != 0` | `ZeroAmount` |
| 2 | `registeredHooks[hook]` | `HookNotRegistered` |
| 3 | 未在黑名单期内 | `IsBlacklisted` |
| 4 | `pogQuota[sender] != 0` | `NoPogQuota` |
| 5 | 该 (钱包, hook) 冷却期已过 | `CooldownActive` |
| 6 | 滚动窗口后 `alreadyIn + amount ≤ pogQuota` | `QuotaExceeded` |
| 7 | 置新冷却期（若 `cooldownDuration > 0`） | — |
| 8 | **先绑推荐关系，再读回**，让首次出资者自己的链接在这一笔就生效 | — |
| 9 | 记账 `quotaSpent` / `totalGenesisDeposited`，转发 ETH 给 hook | — |

**Hook 侧关卡**（`src/ToshLaunchpadHook.sol:624-654`）：

| # | 检查 | 错误 |
|---|---|---|
| 1 | `msg.sender == factory` | `OnlyFactory` |
| 2 | `tokenInitialized` | `NotInitialized` |
| 3 | `block.timestamp < genesisDeadline` | `GenesisExpired` |
| 4 | `msg.value != 0` | `ZeroAmount` |
| 5 | **每钱包上限**：`ethDeposited[user] + amount ≤ perWalletCap` | `PerWalletCapExceeded` |

**双层额度的分工**（`src/ToshFactory.sol:430-436`）：
- `pogQuota` 是**跨项目的平台级预算**，按窗口刷新。
- `perWalletCap` 是**单项目的上限**，对照**创建时的快照**执行，让平台事后调旋钮无法改变正在募集中的项目的条款（`src/ToshLaunchpadHook.sol:335-344`）。测试 `test_perWalletCap_isSnapshottedAtProjectCreation` @ `test/ToshV5.t.sol`。

**软顶** = hook 的 `softCap` immutable，从 `factory.defaultSoftCap` 快照（默认 10 ETH，`src/ToshFactory.sol:92`），下限 `MIN_SOFT_CAP_PROD = 0.01 ether`。这个下限存在的唯一原因是防 `p0` 截断：`GENESIS_LP_SUPPLY = 3.78e24`，一旦 `lpEth < 3,780,000` wei，`p0` 就整除为 0，整条阶梯坍缩成免费铸造区（`src/ToshFactory.sol:45-55`）。纵深防御：`launch()` 里还有 `require(p0 > 0)`（`src/ToshLaunchpadHook.sol:727`）。

**没有硬顶**：代码里**未找到**任何超募拒绝逻辑。达成软顶后仍可继续出资到窗口结束，只受 `perWalletCap` 与 PoG 额度约束。

### 4.4 开盘 —— `launch()`

**四道前置**（`src/ToshLaunchpadHook.sol:704-710`）：

| 检查 | 错误 |
|---|---|
| `msg.sender == creator` | `OnlyCreator` |
| `block.timestamp >= genesisDeadline` | `GenesisActive` |
| `!launched` | `AlreadyLaunched` |
| `totalEthDeposited >= softCap`（且 `!= 0`） | `SoftCapNotMet` / `ZeroAmount` |
| `block.timestamp <= genesisDeadline + LAUNCH_WINDOW(7d)` | `LaunchWindowExpired` |

> **⚠️ 8.7**：即使提前超额达成软顶，creator 也**必须等满整个创世窗口**（3/24/72 小时）才能开盘。与"达成软顶即可开盘"的产品直觉不符，也与前端的相位判定（软顶达成即切"bonding"面板）不一致（⚠️ 8.6）。

**六步执行**（`src/ToshLaunchpadHook.sol:712-765`）：

```
1. launched = true                                          // 重入前置
2. commissionPool = totalReferralReserved + orphanReferral
   lpEth = totalEthDeposited − commissionPool               // 即 90% × R
   require(lpEth > 0)
3. p0 = lpEth × 1e18 / GENESIS_LP_SUPPLY   require(p0 > 0)
   shelfP0 = p0 × 10500 / 10000
4. projectToken.mint(address(this), GENESIS_SUPPLY)          // 8.4M
5. 建池：currency0 = address(0)（ETH，永远排第一）
        currency1 = projectToken
        fee = POOL_FEE(3000), tickSpacing = 200, hooks = this
   sqrtPriceX96 = _toSqrtPriceX96(lpEth, GENESIS_LP_SUPPLY)  // 整数开方
   poolManager.initialize(key, sqrtPriceX96)                 // 触发 beforeInitialize，只允许自己
   poolManager.unlock(ACTION_ADD_LIQUIDITY) → unlockCallback
     → modifyLiquidity(tickLower=-887200, tickUpper=+887200, +liquidity, salt=0)
     → currency0 欠款用 msg.value settle；currency1 欠款用 safeTransfer + settle
6. 播种预言机：lastTick = getTickAtSqrtPrice(sqrtPriceX96)
              lastObservationTs = _prevCheckpointTs = _curCheckpointTs = now
7. orphanReferral 全额转 ladderTreasury，清零，发 OrphanReferralForwarded
8. emit Launched(totalEth, lpEth, liquidity, sqrtPriceX96, p0)
```

**创世流动性为何不需要回调就锁死**（`src/ToshLaunchpadHook.sol` 的 `beforeRemoveLiquidity` 注释，与 `unlockCallback` 的实现）：V4 把每个仓位按调用 `modifyLiquidity` 的地址归属（`Pool.ModifyLiquidityParams.owner = msg.sender`）。创世仓位归 hook，而 hook 的 `unlockCallback` 只识别 `ACTION_ADD_LIQUIDITY`、且 delta 严格为正。任何人（包括 creator、包括 owner）都无法寻址那个仓位。所以锁是**结构性**的，而不是靠一个会 revert 的回调，`BEFORE_REMOVE_LIQUIDITY` 因此从掩码里删除而不是软化成条件 revert。

**`platformTreasury` 快照被删除**（`src/ToshLaunchpadHook.sol:714-718`）：v4.x 在这里快照 `platformTreasury` 以防工厂 owner 事后改动重定向 Phase-2 费流（M-2 修复）。v5.0 不需要快照——所有平台收入都流向 `ladderTreasury`，那是 immutable 构造参数，重定向向量在字节码层面就不存在。

> **⚠️ 8.14**：建池时 `getLiquidityForAmounts` 取两侧的最小值（`src/ToshLaunchpadHook.sol:1225-1231`），所以实际消耗的 ETH 与代币都 ≤ 输入量，余尘留在 hook 里。同理，`claimGenesis` 的整除余尘（`allocation = CLAIM_SUPPLY × dep / total`，`src/ToshLaunchpadHook.sol:775`）也会有极小残余永久留在 hook 中。合约**没有任何清扫路径**。这与国库"单向阀"是同一取舍，但 hook 侧没有被文档化。

### 4.5 失败路径 —— `refund()`

**双门**（`src/ToshLaunchpadHook.sol:657-693`）：

| 门 | 判据 | 事件 |
|---|---|---|
| 软顶未达成 | `ts > genesisDeadline && totalEthDeposited < softCap` | `GenesisFailed(totalEthRaised)`（首次触发时） |
| 僵尸窗口超时 | `ts > genesisDeadline + LAUNCH_WINDOW(7 days)` | `ZombieRefund(totalEthRaised)`（首次触发时） |

第二道门的产品含义：即使软顶达成，只要 creator 在 7 天内不开盘，储户就能全额撤回。这堵住了"募到钱就人间蒸发"的路。

**退款金额 = 100% 的 `ethDeposited[msg.sender]`**（`src/ToshLaunchpadHook.sol:664-667`）。10% 的佣金切分只在 `launch()` 时才真正兑现，所以失败的创世不欠推荐人任何东西，`referralAccrued` 只是单纯变成永不可领（`claimReferralReward` 要求 `launched`，`src/ToshLaunchpadHook.sol:791`）。

**CEI 顺序**：先 `ethDeposited[msg.sender] = 0`（EFFECTS），再置事件标记位，最后 `_sendEth`（INTERACTIONS），外层还有 `nonReentrant`（`src/ToshLaunchpadHook.sol:668`、`679-691`）。

**暂停不影响退款**：测试 `test_pause_doesNotBlockRefund` @ `test/ToshV5Factory.t.sol` 明确固化了这一点（⚠️ 8.12 的另一面：这是好事，但也说明暂停覆盖面很窄）。

### 4.6 Phase 2 —— 阶梯铸造

#### 4.6.1 `mintBondingCurve(uint256 tokenAmount) payable returns (uint256 ethCharged)`

**执行流**（`src/ToshLaunchpadHook.sol:847-926`）：

```
前置：initialized · nonReentrant · launched · tokenAmount != 0

门 1（同区块锁）：block.number <= lastSwapBlock  →  revert SameBlockMintForbidden
                                                     // line 858
tierIndex = currentTierIndex
tierIndex >= TIER_COUNT  →  revert LadderExhausted    // line 861

门 2+3（参考价与天花板，循环外提，因为任何一腿都动不了它）：
    ceiling = _safeReferencePrice() × 10500 / 10000    // line 865

循环（每腿一档）：
    tierIndex >= TIER_COUNT      →  revert ExceedsTierRemaining   // line 873
    ++legs > MAX_TIERS_PER_TX(32) →  revert SpanTooManyShelves     // line 874
    tierPrice = tierPriceAt(tierIndex)
    tierPrice > ceiling          →  revert TierPriceAboveCeiling   // line 877
    room  = TIER_SIZE − sold
    take  = min(tokenAmount − filled, room)
    legCost = tierPrice × take / 1e18       // 每腿向下取整，最坏 1 wei/腿 有利于买家
    emit TierMinted(buyer, tierIndex, tierPrice, take, legCost)
    档位售罄 → sold=0, ++tierIndex, emit TierAdvanced

支付校验：cost == 0 → ZeroAmount；msg.value < cost → InsufficientPayment

EFFECTS：_ladderState = { tierIndex, tierSold, minted + tokenAmount }  // 单槽一次 SSTORE

INTERACTIONS：
    platformCut = cost × 1% → ladderTreasury      // line 914-917
    projectCut  = cost − platformCut → projectAdmin // line 918
    projectToken.mint(msg.sender, tokenAmount)      // line 920
    change = msg.value − cost → 退还 msg.sender     // line 922-923
```

**为什么允许跨档**（`src/ToshLaunchpadHook.sol:831-841`）：货架铸造从代币合约直接发行、ETH 直接路由给 `projectAdmin`/`ladderTreasury`，**从不触碰池子**，所以它动不了 `spot`；TWAP 也只是过去成交的函数。因此反尖峰参考价在整次调用中是**常量**，逐腿复检天花板与"只对最高档检查一次"完全等价。跨 N 档一次成交与同区块内 N 次单档成交达到**同一终态、同一总价**，所以拆分从来不是安全属性，只是买家多付的 gas 税。测试 `test_tierMint_spanIsEquivalentToSequentialShelfBuys` @ `test/ToshV5.t.sol` 把这条不变量钉住。

**`MAX_TIERS_PER_TX = 32` 是 gas 上限，不是安全上限**：撞到这个上限的买家在**同一个区块内**再发一笔就能到达完全相同的终态。它存在只是防止一次调用循环上百次（每腿都要重算 `tierPriceAt`，O(log i)）而 out-of-gas。取 32 而不是原来的 16，是因为市价追平游标时 105% 天花板一次放行 `ln(1.05)/ln(STEP) ≈ 25.7` 档——16 会让腿数先于天花板绑定，逼每个正常买家白付第二笔交易的 gas。测试 `test_tierMint_legCapBindsWhenMarketRunsAhead` @ `test/ToshV5.t.sol` 显式验证了"拆成两笔达到被拒绝的那个状态"。

#### 4.6.2 `quoteMint(uint256) view returns (uint256 ethCost)`

镜像 `mintBondingCurve` 的**每一道检查和每一腿算术**（`src/ToshLaunchpadHook.sol:938-974`）。设计意图写得很清楚：一次成功的报价，就是合约在下一个区块会以**完全相同价格**接受的一次铸造。代码重复是刻意的——共享 helper 要么得分配逐腿数组、要么得走两遍来发事件。`testFuzz_QuoteMatchesMintAcrossSpans` 把两个循环钉在一起（注释 `931-937`；测试文件在 `test/ToshV5Fuzz.t.sol`）。

注意：`quoteMint` 是 `view` 但**会 revert**（`LadderExhausted` / `ExceedsTierRemaining` / `SpanTooManyShelves` / `TierPriceAboveCeiling` / `ZeroAmount`）。前端必须处理 revert 而不是把它当成返回 0。

#### 4.6.3 `maxMintable() view returns (uint256)`

把买家能撞到的**所有数量限制**折叠成一个数（`src/ToshLaunchpadHook.sol:976-1000`）：当前档剩余 + 后续所有仍在 105% 天花板下的档 + 阶梯末端 + `MAX_TIERS_PER_TX`。门关着时返回 0。UI 的 "max" 按钮据此定档，而不是猜 `TIER_SIZE`。测试 `test_maxMintable_isTheExactAcceptedBoundary` @ `test/ToshV5.t.sol` 断言"多一个 wei-token 就 revert"。

#### 4.6.4 视图接口一览

| 函数 | 返回 | 行号 |
|---|---|---|
| `tierPriceAt(i)` | 档 i 的价格（ETH-wei/整枚），`i >= TIER_COUNT` 返回 0 | `1401-1404` |
| `getTier(i)` | `Tier{price, totalAmount, soldAmount}` | `1424-1435` |
| `getTiers(start, count)` | 分页窗口（4000 档 = 12,000 字，无法一次返回） | `1444-1466` |
| `tierCount()` / `tierRemaining()` / `bondingRemaining()` / `currentBondingPrice()` | 计数与当前价 | `1468-1487` |
| `tierStatus()` | `(tierIndex, tierPrice, remaining, spotPrice, twapPrice, ceiling, unlocked)` —— **UI 渲染价格门的全部所需** | `1497-1520` |
| `getPoolKey()` / `hasClaimed(user)` / `claimableReferral(referrer)` | 池 key / 认领位 / 可提佣金 | `1522-1533` |
| `satoDeposited(user)` / `totalSatoDeposited()` | **v4.x 兼容 shim**，分别别名 `ethDeposited` / `totalEthDeposited` | `1535-1546` |

> **⚠️ 8.15**：`phase2Minted` 是独立累加器（`phase2Minted += tokenAmount`），与 `currentTierIndex`/`currentTierSold` 是两套账。正常路径下二者一致，但 `ExceedsTierRemaining` 的错误注释说"读 `bondingRemaining()` 并缩小订单"（`src/ToshLaunchpadHook.sol:502-504`），而实际触发条件是 `tierIndex >= TIER_COUNT`（阶梯档位耗尽）。错误提示指向的 view 与真实触发条件不是同一个量。

### 4.7 创世份额认领 —— `claimGenesis()`

`src/ToshLaunchpadHook.sol:769-781`：

| 检查 | 错误 |
|---|---|
| `launched` | `NotLaunched` |
| `!genesisShareClaimed[sender]` | `AlreadyClaimed` |
| `ethDeposited[sender] != 0` | `NoDeposit` |

```
allocation = GENESIS_CLAIM_SUPPLY × ethDeposited[sender] / totalEthDeposited
```

注意分母是**含 10% 佣金的总募集额** `R`，这正是让储户成本基准等于 `R / 4,620,000` 的定义（与 3.3 的推导一致）。`nonReentrant` + 先置 `genesisShareClaimed` 再 `safeTransfer`。

### 4.8 推荐佣金提取 —— `claimReferralReward()`

`src/ToshLaunchpadHook.sol:783-801`：

| 检查 | 错误 |
|---|---|
| `launched` | `NotLaunched` |
| `referralAccrued[sender] != 0` | `NoReferralReward` |

**刻意不做时间解锁**（`src/ToshLaunchpadHook.sol:785-789`）：金额本身已经与每个被推荐人真实带入的资金成正比，而一个已开盘的项目没有任何机制能把它收回。

### 4.9 平台国库顺风车回购 —— `autoPiggybackBuyback()` 与 `pokeBuyback()`

**两条触发链路，共用一个 `_runPiggyback()`**：

1. **顺风车（受 gas 门控）**：Tosh 池的一笔 swap → hook 的 `afterSwap` → 在 `ladderTreasury.balance >= PIGGYBACK_TRIGGER_STEP` **且** `gasleft() >= PIGGYBACK_MIN_GAS`（230,000）时，`try ... autoPiggybackBuyback{gas: gasleft() - PIGGYBACK_TAIL_RESERVE}()`。
2. **无许可直捅**：任何地址 → `treasury.pokeBuyback()` → `poolManager.unlock("")` → `unlockCallback` → `_runPiggyback()`。

**为什么必须有 gas 门控**：买入税是在 `beforeSwap` 里 `take` 进国库的,所以一笔交易可以**开始时未武装、到 `afterSwap` 时已武装**。这意味着被收费跑回购的那笔交易,恰恰是把储备推过阈值的那一笔——而它的钱包是按未武装的池子估的 gas。不是"倒霉窗口里签的交易",而是**每个周期确定性地都有一笔**。实测一条腿约 125k,门控之后的收尾约 70k,估算里两者都没有。

`try/catch` 救不了它:子调用耗尽 gas 后,63/64 规则只给外层留六十四分之一,不够走完 `afterSwap` 加 V4 关帧。所以门控做两件事——**余量不足就跳过**,并且**用 `{gas: avail - PIGGYBACK_TAIL_RESERVE}` 物理扣下收尾的份额**,让一条腿再贵也吃不到它。

代价是活性:交易不再保证能清空储备。`pokeBuyback()` 是兵底,故意对所有人开放,因为设成 owner-only 就等于把这里刚去掉的活性依赖又请回来。它不给调用者转任何 ETH,也不做任何选择——场所来自 hook,大小来自余额,顺序来自轮转游标,价格受同一条 TWAP 下限约束。唯一能决定的是**时机**,而游标让这件事没什么可图。

**跳过的 poke 不发任何事件**。跳过是常态,记日志要让每个交易者掏钱。所以这个盲区只能靠余额轮询发现,见 `monitoring/alerts.json` 的 `STATE-06`。

**故障隔离的理由写得很细**（`src/ToshLaunchpadHook.sol:1145-1153`）：回购是这笔交易替平台做的**顺手之举**，绝不是交易本身的前置条件。没有 `try/catch` 的话，一个不认识我们的国库（`setFactory` 未接线，或者第二个工厂部署的 hook 永远无法通过一次性绑定注册）会在**每一笔**交易上 revert `onlyHook`，那会把创世流动性永久困死在合约里且无任何恢复路径。被吞掉的 revert 也会回滚该帧的 V4 deltas 和瞬态标记位，所以交易在干净账目上继续。失败时发 `PiggybackPokeFailed(treasury)`——**持续出现这个事件意味着国库不再认识这个 hook**。

**国库侧执行**（`_runPiggyback()`，两条入口共用）：

| 步 | 动作 | 说明 |
|---|---|---|
| 0 | 入口鉴权 | `autoPiggybackBuyback` 是 `onlyHook`（否则 `OnlyHook`）并额外要求 `poolManager.isUnlocked()`；`pokeBuyback` 无鉴权,但自己开 unlock 帧,且未武装时 revert `NotArmed` 而非静默返回 |
| 1 | `piggybackActive()` 已置位 → **静默 return** | 嵌套 Tosh 池 poke 我们时保持被动 |
| 2 | `spend = _nextSpendAmount()`，为 0 → return | `max(TRIGGER_STEP, balance × SPEND_BPS/10000)`，即 `max(1 ETH, 余额 10%)` |
| 3 | `ladderTokens.length == 0` → return | 无策展标的 |
| 4 | `count = min(total, LEGS_PER_POKE)` | **`LEGS_PER_POKE = 1`**：每次 poke 只跑一条腿 |
| 5 | `perToken = spend / BATCH_SIZE` | **`BATCH_SIZE = 3` 现在只是分仓除数,不再是每次的腿数** |
| 6 | 置瞬态标记 `_setPiggyback(true)` | EIP-1153 `tstore` |
| 7 | 轮转 `count` 次：`try this.executeBuyAndBurn(token, perToken) catch { emit BuybackSkipped }` | 逐腿故障隔离；外部自调用让 revert 完整回滚该腿的 V4 deltas，ETH 留在储备里等下一轮 |
| 8 | `currentCursor = (cursor + count) % total` | 轮转推进 |
| 9 | `_setPiggyback(false)`；`emit PiggybackExecuted(perToken*count, count, newCursor)` | 现在 `count` 恒为 1，所以事件频率是原来的三倍，同样的 ETH |

**第 4、5 步为什么是两个独立的数**：原来它们是同一个数,一次 poke 跑三条腿,等于让一个买家替平台付三笔 V4 swap(实测每条约 125k)。峰值 578,809 gas 摆在一个按 217k 估算的人面前。

拆开之后每次只跑一条,但 `perToken` 仍除以 `BATCH_SIZE`,所以**每个池子拿到的 ETH 一分没少**,三笔交易覆盖同样的三个池子。峰值降到 362,884。

分仓除数保持 3 是这件事免费的前提:如果改成除以 1,同样的周期会把三倍的 ETH 灌进单个创世池,在那种薄度上多出的滑点会买到更少的币来烧——用执行质量换 gas,不划算。

**单腿 `_buyAndBurn`**（`src/ToshLadderTreasury.sol` 的 `_buyAndBurn`）：

```
swap(key, { zeroForOne: true,                            // ETH(currency0) → token(currency1)
            amountSpecified: -int256(ethIn),             // 负数 = exact input
            sqrtPriceLimitX96: _buybackSqrtFloor(key) }) // TWAP 锚定的价格下限
sync(native) ; settle{value: spent}()                    // 只付池子真正吃掉的那部分
take(currency1, DEAD_ADDRESS, bought)                    // 代币直送 0xdead
emit BuybackBurned(token, spent, bought)
```

**滑点下限的由来——一次被推翻的推理**（`src/ToshLadderTreasury.sol` 的 `_buyAndBurn` 与 `_buybackSqrtFloor` 注释）：早先的修订确实传 `MIN_SQRT_PRICE + 1`（等于不设限），理由是"产出被销毁，不利价格只是少烧一些币，没有受害者、也没有可提取的 MEV"。**这条推理漏掉了谁在付账**：三明治攻击者可以抢在顺风车之前买入，让这条腿在被抬高的价格上成交，再把币卖回自己刚刚制造出来的接盘盘口。没有任何用户被偷，但储备的 ETH 买到更少的币去烧，差额进了攻击者的口袋——**税收本来要交付的通缩被抽走了**。受害者不是某个交易对手，而是销毁本身。

所以现在每条腿都带下限：`_buybackSqrtFloor` = `hook.twapSqrtPriceX96() × (1 - MAX_BUYBACK_SQRT_DEVIATION_BPS / 10000)`，即 **0.9 × TWAP 的 sqrt 价**（`MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000`）。

- **锚 TWAP 而不是 slot0**：spot 正是三明治要位移的那个量，spot 相对的下限会跟着攻击一起移动，什么都限制不住。对着 TWAP，抢跑把价格拉过下限之后，这条腿只能部分成交或直接落进 `BuybackSkipped`，攻击者手里剩下一批没有出口的存货。
- **必须 `settle` 池子实际吃掉的 `spent`，而不是报出的 `ethIn`**：下限一旦生效就是部分成交，照 `ethIn` 付款会让合约留下一笔无人认领的 credit，撞上 unlock 帧的 all-deltas-zero 检查，把那个碰巧触发了顺风车的无辜交易者的 swap 整笔 revert。没花掉的部分留在储备里等下一轮。
- **TWAP 缺席时回落到无下限**：hook 还没有 TWAP（开盘后第一个窗口，`twapSqrtPriceX96()` 返回 0）或根本不应答这个接口时，`_buybackSqrtFloor` 返回 `MIN_SQRT_PRICE + 1`。拒绝买入是更坏的失败——储备会在任何 hook 早于这个接口的池子上永久停摆。

**这是"设上限"，不是"消除"**：0.9 作用在 sqrt 价上，折算到 ETH-per-token 等于允许池子在腿停止成交之前坐到 TWAP 上方约 23%。`test_probeG_sandwichThePiggyback` @ `test/ToshV5Attack.t.sol` 是一个**测量**探针（记录 edge，不做断言），并且点明可抽取的规模随储备线性增长：`spend = max(1 ETH, 10% 储备)`，只挂一个代币时这笔钱全部落进同一个池子。`docs/SECURITY_AUDIT.md` 相应地把这一项记作"`MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000` 限制可执行偏差"，而不是记作已关闭。

**和链下 harvest 机器人的关系**：能删掉机器人靠的不是"没有滑点下限"，而是顺风车这条路径**绝不 revert**——每条腿都包在 `try/catch` 里，失败就 `emit BuybackSkipped` 把 ETH 留给下一轮。正因为有这层故障隔离，补上下限才是免费的：违反下限的腿被跳过，而不会把无辜交易者的 swap 一起带走。

**关键行为**：`_runPiggyback` **绝不因"未就绪"而 revert**——顺风车入口坐在普通用户 swap 的热路径上，在这里 revert 会让池子不可交易。所有前置条件都是早返回。`pokeBuyback` 是唯一的例外,它会 revert `NotArmed`:那不是任何人的热路径,调用者有权知道这次调用什么都没做。
>
> **⚠️ 8.22**：`addLadderToken` 的来源校验解决的是"钱花到哪个池子"，**不解决"哪些项目享受回购"**。owner 仍可只挂自己/关联方的项目，或用 `removeLadderToken` 把某项目永久排除在轮转之外。这是策展权限本身的信任边界。

**策展校验**（`src/ToshLadderTreasury.sol:200-226`）：

| 检查 | 错误 |
|---|---|
| `token != 0` | `ZeroAddress` |
| 未重复挂牌 | `TokenAlreadyListed` |
| `factory != 0` | `FactoryNotSet` |
| `factory.tokenToHook(token) != 0` —— **本平台发射的代币** | `TokenNotLaunchedHere` |
| `key.currency0.isAddressZero()` —— ETH 必须是 currency0 | `InvalidPoolKey` |
| `key.currency1 == token` | `InvalidPoolKey` |
| `key.hooks == hook` | `InvalidPoolKey` |

未开盘的 hook 没有 pool key（零 key），会在 `currency1` 那一臂失败（测试 `test_ladderCuration_rejectsUnlaunchedProjects` @ `test/ToshV5.t.sol`，期望 `InvalidPoolKey`）。

**`removeLadderToken`** 用 swap-and-pop 保持数组紧凑，会打乱轮转顺序——注释说这是可接受的：游标只需要在范围内且长期公平，不需要跨摘牌稳定（`src/ToshLadderTreasury.sol:228-254`）。

---

## 5. 安全与反操纵机制

### 5.1 三重价格门控

| 门 | 机制 | 挡什么 | 行号 |
|---|---|---|---|
| **1. 同区块铸造禁令** | 任何本池 swap 在 `afterSwap` 里写 `lastSwapBlock = block.number`；**`launch()` 也会主动盖上这个戳**；`mintBondingCurve` 若 `block.number <= lastSwapBlock` 直接 revert `SameBlockMintForbidden` | 闪电贷拉盘 → 同区块铸造 → 平仓。价格门在闪电贷解开前根本看不到那个价格。`launch()` 盖戳则让开盘区块对所有募资额确定性关闭（§8.26） | `afterSwap` / `launch` / `mintBondingCurve` |
| **2. `min(spot, 慢速腿)` 参考价** | `_safeReferencePrice()`：TWAP 窗口成熟后取 `min(spot, TWAP)`；窗口未满 `TWAP_WINDOW`（含 `twap == 0`）时取 `min(spot, p0)`，不盲信短窗 stub | 把 spot 往上拉不动参考价；开盘后头 30 分钟的两步脉冲最多顶开货架 0，不能满档扫空 | `_safeReferencePrice` |
| **3. 105% 天花板** | 档价必须 `≤ 1.05 × 参考价` | 档位只在二级市场**真实、持久**涨上来之后才解锁。阶梯被真实需求**拉上去**，而不是被发行方**推上去** | `PRICE_CEILING_BPS` / `mintBondingCurve` |

`maxMintable()` 同样受门 1 约束（`block.number <= lastSwapBlock` 时返回 0），因为它的语义是"此刻能买多少"，UI 的 max 按钮直接取它——报出一个下一笔调用必然拒绝的数量只会变成一笔失败交易。`quoteMint` 则**有意**不加这条：报价是对下个区块成交单价的承诺，而同区块锁与单价无关。

测试覆盖：`test_tierMintAntiSpikeAndCeiling` @ `test/ToshV5.t.sol`（门 1 + 门 3 端到端）；`test_tierMint_twapDefeatsASingleBlockPump`（成熟窗口下单区块拉盘被 TWAP 挡住）；`test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump`（开盘窗口 `min(spot, p0)` 挡住两步脉冲）；`test_ladderOpensLockedAtLaunch_acrossRaiseSizes`（开盘锁对 1–10 ETH 每个募资额都成立）。

**Hook 本地 TWAP 预言机**（`src/ToshLaunchpadHook.sol:418-430`、`1268-1328`）：

Uniswap V4 core **不带**观测缓冲（V3 有），所以 hook 自己在每次 `afterSwap` 里累加 `tick × elapsed`：

```
_writeObservation():
    elapsed = now − lastObservationTs
    if elapsed > 0:
        tickCumulative += lastTick × elapsed
        lastObservationTs = now
        if now − _curCheckpointTs >= TWAP_WINDOW(1800s):
            _prev ← _cur ; _cur ← (now, tickCumulative)   // 滚动检查点
    lastTick = poolManager.getSlot0(poolId).tick

_getTWAPPrice():
    span = now − _prevCheckpointTs ;  span < TWAP_WINDOW → return 0
    cumNow = tickCumulative + lastTick × (now − lastObservationTs)
    avgTick = (cumNow − _prevCheckpointCumulative) / span
    // 向负无穷取整，对齐 Uniswap V3 OracleLibrary，避免截断导致 TWAP 上偏
    if delta < 0 && delta % span != 0: avgTick--
    clamp 到 [MIN_TICK, MAX_TICK]
    return _sqrtPriceToEthPerToken(getSqrtPriceAtTick(avgTick))
```

**只保两个滚动检查点而不是完整环形缓冲**，把每笔成交的成本压到"每窗口一次冷 SSTORE"而不是"每笔一次"（`src/ToshLaunchpadHook.sol:1277-1280`）。

> **⚠️ 8.20**：代价是**实测窗口在 [1800, 3600) 秒之间漂移**（`TWAP_WINDOW` natspec）。`_getTWAPPrice()` 在 `span < TWAP_WINDOW` 时返回 0；短非零窗口（开盘后几秒）不是 TWAP，也不再被当成 TWAP 对外报出。`_safeReferencePrice` 在同样条件下取 `min(spot, p0)`，而不是盲信 spot / stub。开盘后头 30 分钟的两步脉冲因此无法把天花板推开。测试 `test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump`。
>
> **⚠️ 8.29（TWAP 深度就是这个常数）**：检查点的滚动由"第一笔落在 `_cur` 之后 ≥ `TWAP_WINDOW` 的 swap"触发，而**任何人都能提供那笔 swap**。把价格顶住一个窗口再用灰尘 swap 一戳，均价就会收敛到被操纵的价位——旧的 600s 参数下实测约 10 分钟就能让 TWAP 贴到操纵 spot 的 0.001% 以内并打开满档。两检查点结构下这没有结构性解法：**深度就等于 `TWAP_WINDOW`**。所以这个常数是一个**价格**而不是一个保证，取 1800s 是把攻击者的持仓成本翻三倍，同时仍让真实上涨的市场能在一小时内打开自己的阶梯。要更深就得改成完整环形缓冲（一次不小的重写，且把成本推回"每笔一次 SSTORE"）。测试 `test_probeB_twapReanchorSpeed` 把这个行为钉住，任何重新调参都必须重述它买到了什么。
>
> **⚠️ 8.30（TWAP 的两个消费方口径已对齐）**：`twapSqrtPriceX96()` 曾经只要 `span > 0` 就返回读数，也就是开盘一秒后返回一个"一秒均价"。`_safeReferencePrice` 从不信它（未成熟就用 `p0` 封顶），但国库的 `_buybackSqrtFloor` 信——而后者把 0 当作"还没有参考价，本轮无界成交"的既定回退。于是那个不成熟的桩**比它本该拿到的回退更糟**：把反三明治地板锚在一笔 swap 就能设定的数上。现在未满窗口一律返回 0，两个消费方对"TWAP 何时存在"达成一致。

**价格换算**（`src/ToshLaunchpadHook.sol:1330-1341`）：ETH 是 currency0，`sqrtPriceX96 = sqrt(token/ETH) × 2^96`，所以 `ethPerToken = 2^192 / sqrtPriceX96²`。分两步 `mulDiv` 求值，因为 tick 范围顶端 `sqrtPriceX96²` 会溢出 uint256。

### 5.2 EIP-1153 瞬态存储重入锁与顺风车递归抑制

**两层锁**：

1. **OpenZeppelin `ReentrancyGuard`（持久存储）**：hook 继承 `ReentrancyGuard`（`src/ToshLaunchpadHook.sol:127`），`nonReentrant` 覆盖 `refund` / `launch` / `claimGenesis` / `claimReferralReward` / `mintBondingCurve`。工厂也继承并覆盖 `createLaunch` / `deposit`（`src/ToshFactory.sol:36`、`354`、`442`）。

2. **EIP-1153 瞬态标记位（`tstore`/`tload`）**：国库在槽位 `0x546f73685069676779626163b1000001` 上放递归守卫（`src/ToshLadderTreasury.sol:79-85`、`359-363`、`385-389`）。用瞬态存储的理由是"这个标记只在当前交易内有意义"。

**递归抑制的必要性**（`src/ToshLadderTreasury.sol:80-84`）：一次顺风车会穿过**其他** Tosh 池买入，那些池的 hook 否则会对这笔回购抽税并**再触发一次嵌套顺风车**。所以 hook 在 `beforeSwap` 和 `afterSwap` 的第一行都读 `piggybackActive()`，为真时**完全被动**（`src/ToshLaunchpadHook.sol:1092-1096`、`1134-1136`）：

```solidity
if (sender == ladderTreasury || _piggybackActive()) { /* 零 delta，不写预言机，不 poke */ }
```

`sender == ladderTreasury` 是第一层（国库自己发起的 swap 直接豁免），`_piggybackActive()` 是第二层（跨 hook 的递归）。测试 `test_piggyback_isolatesAFaultyLadderLeg` @ `test/ToshV5.t.sol` 验证一条坏腿不会砸掉无辜交易者的 swap。

### 5.3 CREATE2 掩码保证 hook 权限位

见 4.2 的掩码表。要点：

- V4 的 `PoolManager` 用地址低 14 位决定调哪些回调。掩码 `0x20CC` 是能让这个 hook 的五个活跃权限位被真正调用的组合（四个回调 + `AFTER_SWAP_RETURNS_DELTA`）。
- `isValidHookAddress` 除了检查 `REQUIRED_FLAGS`，还复核 V4 自己的一致性规则（return-delta 位必须有对应的 action 位）（`src/libraries/HookMiner.sol:79-90`）。
- 工厂在部署**之前**就用预测地址跑这个校验，不通过就 revert `InvalidHookSalt`，避免部署一个 V4 永远不会调用的 hook（`src/ToshFactory.sol:385-386`）。
- 测试 `test_minedHookAddress_carriesV5FlagMask` @ `test/ToshV5.t.sol`、`test_hookMiner_requiredFlagsAre0x20CC` @ `test/ToshV5Guards.t.sol:246`。

**建池抢跑防御**：`beforeInitialize` 要求 `sender == address(this)`，否则 revert `UnauthorizedInitialization`（`src/ToshLaunchpadHook.sol` 的 `beforeInitialize`）。也就是说这个池子**只能**从 hook 自己的 `launch()` 里创建，外人无法抢先用别的初始价格建起同一个池。测试 `test_beforeInitialize_revertsForExternalSender` @ `test/ToshV5Guards.t.sol`。

### 5.4 创世流动性永久锁定 与 散户 LP 的隔离

已在 4.4 详述。补充要点：

- **锁的来源不是回调**，是"V4 按 `msg.sender` 归属仓位 + hook 无移除代码路径"。`beforeRemoveLiquidity` 现在只是个 pass-through，V4 甚至不会调它（掩码里没设那一位）（`src/ToshLaunchpadHook.sol` 的 `beforeRemoveLiquidity`）。
- 散户 LP 走**自己的**仓位 key，加/撤都不动创世仓位。测试 `test_retailLp_canAddAndRemoveWithoutTouchingGenesis` @ `test/ToshV5.t.sol` 分别断言了加仓后、撤仓后创世流动性都不变。
- `TICK_SPACING = 200` 是为了让 `TICK_LOWER/UPPER = ∓887200` 保持对齐、创世区间不变。代价是散户 LP 只能在约 2% 的网格上放区间边界——注释承认这"粗糙但对刚发射的代币可用"（`src/ToshLaunchpadHook.sol:304-308`）。

### 5.5 国库单向阀设计

`src/ToshLadderTreasury.sol:37-51` 给出了**可 grep 的审计清单**（该文件必须零匹配）：

```
· function withdraw    —— 设计上缺席
· function sweep       —— 设计上缺席
· function rescue      —— 设计上缺席
· delegatecall         —— 设计上缺席
· .transfer( / .call{value  在 _buyAndBurn 之外 —— 设计上缺席
```

唯一移动 ETH 出去的代码路径是 `_buyAndBurn`，其产出币种的收款地址硬编码为 `DEAD_ADDRESS`。owner 的权限被限制在"策展哪些代币坐在阶梯上"。

`executeBuyAndBurn` 之所以是 `external`，纯粹是为了让 `_runPiggyback`（顺风车与 `pokeBuyback` 两条入口共用）能用 `try/catch` 做逐腿故障隔离；`onlySelf` 修饰器保证除了合约自己没人能调。测试 `test_executeBuyAndBurn_isNotCallableExternally` @ `test/ToshV5.t.sol`。

### 5.6 已知性质一：货架套利窗口（经产品决策明确接受）

> **这一节如实记录现状，不宣称"已解决"。**

**机制**：105% 门控是**天花板，不是地板**。它只拒绝价格**高于** `min(spot, TWAP) × 1.05` 的货架，对价格**低于**参考价的货架**一句话都没说**。因此：

- 市场自然上涨后，低档货架（`tierPriceAt(0)`、`tierPriceAt(1)`…）处于**深度价内**。
- 游标每卖掉 3,150 枚才前进 0.190%，而**一笔 swap 可以把价格推高任意幅度**。阶梯追不上市价。
- 于是任何人——**不限于项目方**——都可以扫掉这批价内货架，砸回池子获利。

**代码里的对应断言**（`test/ToshV5.t.sol`，测试名 `test_sweepIsProfitableOnceTheMarketHasRunAhead`）：

测试的 natspec 把这件事说得毫不掩饰，原文要点：

> "The 105% gate is a ceiling, not a floor. It refuses shelves priced ABOVE `min(spot, TWAP)` and says nothing about shelves priced below, so appreciation leaves the low shelves in the money. That spread is the entire incentive to sweep, and sweeping is how the ladder tracks a market that has moved: the cursor advances 0.190% per 3,150 tokens while a single swap can move price by any amount.
>
> The cost is real and is borne by holders — the sweeper's exit drains pool ETH and pushes price back toward the cursor, which caps how far a rally can durably run. **This is an accepted trade, not an oversight.** If it is ever revisited, the fix is a floor on the charged unit price (`max(tierPriceAt(i), min(spot, TWAP))`), which needs no change to the shelf ledger."

测试用 `FreeRider` 合约（持有并花自己的 ETH，避免 `vm.prank` 造成的收支不对账，见 `test_sweepIsProfitableOnceTheMarketHasRunAhead` @ `test/ToshV5.t.sol`）实际跑通了这个套利，断言 `address(rider).balance > before`，并用 `assertLt(profit, cost * 2)` 把量级钉住（防止未来的定价改动**悄悄扩大**这个窗口）。

**实测数据（来自产品方的测量运行）**：

| 场景 | 扫货成本 | 净利 | 回报率 | 特权 |
|---|---|---|---|---|
| 市场先投入 0.5 ETH 拉盘，外部套利者扫货并砸回池子 | 0.0689 ETH | 0.0683 ETH | ≈ **+99%** | **无任何特权** |
| 同样操作，但由项目方执行（享有 99% 货架返佣） | 0.0689 ETH | 0.1366 ETH | ≈ **+198%** | 仅 `projectAdmin` 的返佣 |

> **这三个具体数字在代码中未找到依据。** 仓库里只有定性断言（`assertGt(balance, before)`）和量级边界（`profit < cost × 2`）；`test_sweepIsProfitableOnceTheMarketHasRunAhead` 用的是 `_openLadder(hook, 0.5 ether)` 这个 0.5 ETH 拉盘规模（`test/ToshV5.t.sol`），与上表的实验设置一致，但精确的成本/利润数值是一次测量运行的结果，不是签入仓库的断言。如需回归保护，建议把这三个数字（或它们的比值下限）固化成断言。

**产品决策口径（如实转述）**：

1. 这是**经明确接受**的机制，不是疏漏。
2. 它是**货架追踪市价的动力来源**——没有这个价差，游标永远追不上一个已经跑起来的市场。
3. 代价是**给币价加了一个软顶**：套利者的退出会抽走池子 ETH 并把价格压回游标附近，限制了一轮涨势能持续走多远。
4. 成本由 **LP 与二级持有人**承担。
5. 项目方因享有 99% 货架返佣，做同样操作的回报约为外部套利者的两倍。返佣不改变套利是否成立，只放大项目方的收益。
6. **若未来要收窄**：方案是给成交单价加市价地板 `max(tierPriceAt(i), min(spot, TWAP))`。这只改单腿的计价，**不需要改动货架账本**（`currentTierIndex` / `currentTierSold` / `phase2Minted` 的语义不变）。

**对比：什么时候扫货是亏钱的**（`test_sweepAndDumpIsLossMaking` @ `test/ToshV5.t.sol`）：当市场**没有**跑在阶梯前面时，扫货必亏。理由是结构性的：货架铸造不触碰池子，所以拖不动 spot 跟上来；买家至少按 1.05× 市价付款，然后必须用自己的规模把同一个市场**往下砸**才能卖出，这还没算 1.00% 的往返摩擦。断言是"亏损必须 > 成本的 1/20"（实质性亏损，不是边际亏损）。

**两个测试合起来才是完整的产品陈述**：即时铸造砸盘永远亏；滞后套利（市场先涨）稳定赚。前者是安全属性，后者是设计代价。

### 5.7 已知性质二：国库策展的信任边界

**现状（已修复的部分）**：`addLadderToken` 现已**强制校验代币来源**——必须是本平台 `tokenToHook` 注册且**已开盘**的项目，且回购池子的 `PoolKey` **从 hook 反查而非由 owner 提供**（`src/ToshLadderTreasury.sol:200-226`）。

**被关掉的攻击路径**（注释原文见 `src/ToshLadderTreasury.sol` 的 `addLadderToken` 注释）：早期版本允许 owner 连同代币一起传入任意 `PoolKey`，只校验币种排序。这**静默地击穿了单向阀**：owner 可以铸一个一文不值的 ERC-20，把它配在一个只有自己提供流动性的无 hook 池里，挂上阶梯，然后让每一次 1 ETH 回购都结算进自己的仓位——**一次触发抽走一点**，而链上只会看到普普通通的 `BuybackBurned` 事件。

**现在有两个事实让场地不可伪造**：
1. `tokenToHook` 证明这个代币是本平台发射的；
2. `PoolKey` 从那个 hook 读回，所以 ETH 只能花在 hook 自己巡查的那个深度创世池里。

两者都依赖 `factory`，**这正是它的绑定必须一次性的原因**——一个可重指的工厂会把这两个问题的答案交回 owner 手里（`src/ToshLadderTreasury.sol:193-196`）。

测试：`test_ladderCuration_rejectsForeignTokens` @ `test/ToshV5.t.sol`；`test_ladderTreasury_ownerCannotRedirectSpendToOwnPool` @ `test/ToshV5.t.sol`（这个测试的 natspec 特意说明"探测有没有 `withdraw` 选择器证明不了什么，真正的抽资路线是重定向支出方向"）。

**仍然存在的信任边界（⚠️ 8.22）**：来源校验解决的是**"钱花到哪个池子"**，不解决**"哪些项目享受回购"**。owner 依然可以：
- 只挂自己或关联方的项目；
- 用 `removeLadderToken` 把某个项目永久排除在轮转之外；
- 通过挂牌顺序影响 `currentCursor` 的轮转序列（`removeLadderToken` 的 swap-and-pop 会打乱顺序，注释承认这一点）。

这是**策展权限本身**的边界，不是可以靠代码消掉的东西。要收窄只能靠治理（把 owner 换成多签/DAO，`script/DeployMainnet.s.sol:97-102` 已经强制 `PROD_OWNER_SAFE != deployer` 并做两步移交）。

### 5.8 其他安全设计

| 机制 | 说明 | 行号 |
|---|---|---|
| `ToshToken` 无 `DEFAULT_ADMIN_ROLE` | 构造时不授予任何角色，`initialize` 只授 `MINTER_ROLE` 给 hook。结果：**没有任何地址能调 `grantRole`/`revokeRole`**，唯一剩下的变更是 hook 对自己 `renounceRole` | `src/ToshToken.sol:74-79`、`94-104` |
| 硬顶在 mint 时逐笔校验 | `totalSupply() + amount > MAX_SUPPLY` → `MaxSupplyExceeded` | `src/ToshToken.sol:111-114` |
| **没有** kill-switch（有意为之） | 曾有 `renounceMinterRole()` 并被当作紧急逃生口写进文档，实际上只有 `MINTER_ROLE` 能调、而该角色只属于 hook、hook 又没有任何调用它的代码路径——在已部署系统上无人可达。其测试之所以过，是因为伪造了 hook 作为 caller。与其留一个并不存在的安全控制，不如删掉：供应量由 `mint` 里的 `MAX_SUPPLY` 逐笔封顶，不需要任何人介入 | `ToshToken.mint`（文件末尾注释记录了删除理由） |
| `Ownable2Step` | 工厂与国库都用两步移交，Safe 必须主动 `acceptOwnership` | `src/ToshFactory.sol:36`；`src/ToshLadderTreasury.sol:62` |
| 发射费滑点保护 | `expectedFee` 参数防 owner 抢跑抬费 | `src/ToshFactory.sol:339-341`、`358-359` |
| 名称抢注防御 | `(name, symbol)` 元组一次性占用 | `src/ToshFactory.sol:143`、`364-365`、`408` |
| 创作者绑定盐 | `finalSalt = keccak256(abi.encode(creator, rawSalt))`，别人的盐在你身上无效 | `src/ToshFactory.sol` 的 `createLaunch` |
| `SafeCast.toInt128(tax)` | 交回 V4 flash accounting 的唯一数值做了检查转换，静默截断会错报抽税额 | `src/ToshLaunchpadHook.sol:1118-1120` |
| TWAP 向负无穷取整 | 对齐 Uniswap V3 `OracleLibrary`，保证 TWAP 不被截断上偏 | `src/ToshLaunchpadHook.sol` 的 `_twapSqrtPriceX96` |
| 部署后不变量巡检脚本 | `VerifyDeployment.s.sol` 断言 6 类不变量，包括 `treasury.factory() == factory`（未接线会静默关掉本次部署的所有回购） | `script/VerifyDeployment.s.sol:55-109` |
> **⚠️ 8.12**：`Pausable` 只覆盖工厂的**两个**入口——`createLaunch` 与 `registerPoG`。
>
> **`deposit` 不在其中。** 它只有 `nonReentrant`，没有 `whenNotPaused`（`src/ToshFactory.sol` `deposit`），所以**暂停期间一个已开启的创世轮次仍然照常收款**。这是刻意的，与退款不被暂停是同一条原则：平台已经开门收钱的轮次，不能被一个 owner 开关中途掐断。测试 `test_pause_doesNotBlockDepositIntoALiveRound` 与 `test_pause_doesNotBlockRefund` @ `test/ToshV5Factory.t.sol` 两面都钉住了。
>
> 本条此前长期误写为「三个入口，含 `deposit`」，事故手册 §2 Step 2 也照抄了这个错误。**这类错误的代价是在事故中做出错误判断**——响应者以为按下暂停就止住了入金，实际没有。已于 v5.0 红队复查后一并修正。
>
> **hook 侧的 `launch` / `mintBondingCurve` / `claimGenesis` / `claimReferralReward` / `refund`，以及池子上的所有 swap 和 LP 操作，都不受 `pause()` 影响。**
>
> **已被 D3 部分修订**：`pause()` 的覆盖面没有变，但平台现在另有一个独立刹车 `haltLadderMinting`，能停掉已开盘项目的**阶梯铸造**（且仅此一项）。它会在 7 天内自动失效、可按项目分域、且不触及任何用户余额路径。因此「没有任何协议级熔断开关」这句话已不再成立，准确的表述是：**平台能停售阶梯，不能停交易、不能停领取、不能停退款**。见 §11 D3。

---

## 6. 前端与用户交互规格

技术栈：Next.js（App Router）+ wagmi v2 + viem。目标链：**Base Sepolia (84532)**，主网标称 Ethereum（仅文案）。

### 6.1 页面与组件清单

| 路径 | 角色 | 说明 |
|---|---|---|
| `soat-frontend/src/app/page.tsx` | 首页 | 极薄，转发到目录首页 |
| `soat-frontend/src/app/launch/page.tsx` | **发射台**（Genesis Console） | 34KB。表单 + 创世时长三档 + 客户端挖盐 + Immutable Pact 侧栏 |
| `soat-frontend/src/app/projects/page.tsx` | 项目列表 | 现在只是一个 `redirect()`；目录/雷达视图已搬到 `soat-frontend/src/components/directory/`（`AgentDirectoryHome.tsx` 等） |
| `soat-frontend/src/app/projects/[address]/page.tsx` | 项目详情 | 装载 `ProjectTerminal` |
| `soat-frontend/src/components/ProjectTerminal/` | **项目终端**（规范实现，已拆成目录） | `index.tsx` 是相位状态机与批量读取；每个面板一个文件（`GenesisPanel`、`BondingPanel`、`LiquidityPanel`、`RefundPanel`、`AwaitingLaunchPanel`、`GenesisClaimPanel`、`ReferralPanel`、`QuotaLedger`、`HeroStats`、`ShelfLadder`、`PogScanButton`），加 `phase.ts` / `format.ts` / `pogAuthCache.ts` |
| `soat-frontend/src/app/admin/page.tsx` | Owner Command Center（51KB） | 软顶/发射费/额度/冷却/黑名单/签名者，全部走工厂的 owner 函数 |
| `soat-frontend/src/components/UserDrawer.tsx` | 个人主权控制台 | PoG 额度、冷却矩阵、已参与资产 + `claimGenesis` 入口 |
| `soat-frontend/src/components/NetworkGuard.tsx` + `NetworkGuardClient.tsx` | 网络守卫 | 见 6.3 |
| `soat-frontend/src/app/api/pog/*`、`sign-allocation`、`admin/config`、`projects` | 服务端路由 | PoG 签名（服务端持私钥）、目录同步、管理配置 |

**共享层**：

| 文件 | 职责 |
|---|---|
| `soat-frontend/src/lib/contracts.ts` | **唯一真源**：地址、链 ID、以及从 Solidity 镜像过来的常量护栏。`src/app/lib/contracts.ts` 只是 re-export shim |
| `soat-frontend/src/app/lib/abis.ts` / `src/abis/index.ts` | FACTORY/HOOK/ERC20 ABI（76KB，两处同内容） |
| `soat-frontend/src/app/lib/hookMiner.ts` | TS 版 CREATE2 矿机（Solidity `HookMiner` 的镜像） |
| `soat-frontend/src/lib/v4Math.ts` | LP 面板需要的 V4 定点数学切片 |
| `soat-frontend/src/lib/lpActions.ts` | posm action payload 编码 |
| `soat-frontend/src/lib/useLpPosition.ts` | 散户 LP 数据层（仓位发现） |
| `soat-frontend/src/app/lib/useTosh.ts` | `createLaunch` / `registerPoG` 的 wagmi 封装（双 slot 隔离） |
| `soat-frontend/src/app/lib/useContractActions.ts` | 四个动作的统一封装（deposit / claim / refund / mint） |

### 6.2 从 Solidity 镜像的常量护栏

`soat-frontend/src/lib/contracts.ts` 的文件头（`:10-12`）说明了这些常量的**用途**：UI 必须本地遵守这些审计悬崖，好让钱包弹窗**永远不会为一笔注定失败的交易打开**。

| 常量 | 值 | 镜像自 | 行号 |
|---|---|---|---|
| `MIN_SOFT_CAP_PROD` | `10n ** 16n`（0.01 ETH） | `Factory.MIN_SOFT_CAP_PROD` | `:114` |
| `GENESIS_SUPPLY` | 8,400,000e18 | `Hook.GENESIS_SUPPLY` | `:117` |
| `GENESIS_CLAIM_SUPPLY` | 4,620,000e18 | `Hook.GENESIS_CLAIM_SUPPLY` | `:117` |
| `GENESIS_LP_SUPPLY` | 3,780,000e18 | `Hook.GENESIS_LP_SUPPLY` | `:117` |
| `BONDING_MAX` | 12,600,000e18 | `Hook.BONDING_MAX` | `:118` |
| `TIER_COUNT` | 4000 | `Hook.TIER_COUNT` |
| `TIER_SIZE` | 3,150e18 | `Hook.TIER_SIZE` |
| `PRICE_CEILING_BPS` | 10,500 | `Hook.PRICE_CEILING_BPS` | `:125` |
| `MAX_TIERS_PER_TX` | 32（注释要求"优先读链上 `maxMintable()`"） | `Hook.MAX_TIERS_PER_TX` | `:128-133` |
| `TIER_STEP_E18` / `LADDER_SPAN` | `1_001_902_508_266_805_824` / 2000 | `Hook.TIER_STEP_E18` | `:149-155` |
| `TICK_LOWER` / `TICK_UPPER` | ∓887,200 | `Hook.TICK_LOWER/UPPER` | `:63-64` |
| `POOL_FEE` / `TICK_SPACING` | 3000 / 200 | `Hook.POOL_FEE/TICK_SPACING` | `:65-66` |
| `ADMIN_BATCH_MAX` | 200 | `Factory.setBlacklist` 的 `require` | `:135` |
| `REQUIRED_FLAGS` | `0x20CC` | `HookMiner.REQUIRED_FLAGS` | `hookMiner.ts:6` |
| `GENESIS_DURATION_*` | 10,800 / 86,400 / 259,200 秒 | `Hook.DURATION_*` | `hookMiner.ts:41-43` |

**硬编码的链上地址**（`soat-frontend/src/lib/contracts.ts:41-60`）：

| 常量 | 地址 | 备注 |
|---|---|---|
| `POOL_MANAGER` | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` | **故意不绑环境变量**——错的 PoolManager 会静默地把每个 hook 都 CREATE2 算错 |
| `POSITION_MANAGER` | `0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80` | 注释警告：早先的 Base Sepolia posm `0xda4910cd…` 是针对**错的** PoolManager 部署的，对它的所有流动性调用都会 revert |
| `PERMIT2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 全链同址 |
| `STATE_VIEW` | `0x571291b572ed32ce6751a2cb2486ebee8defb9b4` | 只读 `getSlot0` / `getLiquidity`，让 LP 面板按真实 `sqrtPriceX96` 定量 |

只有 `FACTORY_ADDRESS`（必需，缺失时启动即抛错，`:31-35`）和 `LADDER_TREASURY_ADDRESS`（可选）来自环境变量。

> **⚠️ 8.24**：以上四个地址与 `NetworkGuard` 的 84532 都硬编码在源码里。**主网上线需要改代码，不是改环境变量。**

### 6.3 钱包连接与网络守卫 `NetworkGuard`

`soat-frontend/src/components/NetworkGuard.tsx` 的 `NetworkGuard()`：

- SSR/CSR 挂载守卫（`mounted` 状态），避免水合不匹配。
- 渲染条件：`mounted && isConnected && chainId !== BASE_SEPOLIA_ID`。未连接或已在正确链上时**返回 null**（不占位）。
- 展示一条琥珀色横幅：`"Wrong network — Tosh settles on {Ethereum}; staging runs on {Base Sepolia}. Switch to continue."` + 一个 `switchChainAsync({ chainId: 84532 })` 按钮，失败静默 `.catch(() => {})`。
- 发射台页面另有自己的守卫层：`isWrongNetwork` 会把主 CTA 改成 `Switch to Base Sepolia`（`soat-frontend/src/app/launch/page.tsx:331`），且 `handleLaunch` 在发交易前会主动切链并等 300ms（`:524-527`）。
- 所有写操作都绑定目标链，让 wagmi 在错链时直接拒绝而不是发到错的链上。**绑定点已经从各个调用点收拢到一处**：`useTxAction`（`soat-frontend/src/components/ui/useTxAction.ts`）在 `send` / `sendAsync` 里统一注入 `chainId: TARGET_CHAIN_ID`，并且**故意不把 `chainId` 放进 `TxRequest` 类型**——调用方既不可能忘记，也不可能覆盖。ProjectTerminal 与 admin 的每个面板都走这条路径；`useTosh.ts` 里的 `createLaunch` / `registerPoG` 两个 slot 仍在各自的 `writeContract` 里自带 `chainId: TARGET_CHAIN_ID`。

### 6.4 发射台表单（`/launch`）

**表单字段**（`soat-frontend/src/app/launch/page.tsx`）：

| 字段 | 状态 | 说明 | 行号 |
|---|---|---|---|
| Agent Name | 可编辑 | 必填 | `:609-614` |
| Ticker (Symbol) | 可编辑，自动大写 | 必填 | `:615-621` |
| Project Treasury | **只读、自动锁定为连接钱包** | `treasury = address`（`:468`） | `:622-629` |
| Project Admin | 可编辑，默认填连接钱包 | 校验 `isAddress`；与钱包不同时给琥珀色提示 | `:630-652` |
| **Genesis Window** | 三档 Segmented Control | 见下 | `:653-661` |
| Manifesto / Image URL / Website / Twitter / Telegram | 可选，仅链下目录用 | 走 `POST /api/projects` | `:665-679` |
| Acknowledgement 勾选框 | 必须勾选才能提交 | 复述发射费、软顶、冷却、退款 | `:696-714` |

**创世时长三档 Segmented Control**（`GenesisWindowSelect`，`soat-frontend/src/app/launch/page.tsx:110-165`）：

- `role="radiogroup"` + 三个 `role="radio"` 按钮，`aria-checked` 正确设置（无障碍到位）。
- 标签上方写死 `"immutable once deployed"`。
- 每档下方显示定位话术（见 4.3.1 表格）。
- 默认 `GENESIS_DURATION_STANDARD`（24h）。

**Immutable Pact 侧栏**（`:194-230`、`:472-481`）——右栏粘性面板，列出 8 条"初始化即同意的不可变规则"：发射费 / 创世软顶 / 每钱包上限 / 曲线类型（"2 000-shelf ladder"）/ 创世窗口 / 退款机制 / 部署网络 / 目标主网。底部还有一段琥珀色说明："若创世失败（软顶未达成）或 7 天发射窗口过期而曲线未激活，储户可调 `refund()` 全额取回 ETH，无罚。"

**主 CTA 状态机**（`LaunchCTA`，`:303-393`），按优先级短路：

```
1. !isConnected        → "Connect wallet to continue"（禁用）
2. isWrongNetwork      → "Switch to Base Sepolia"（可点，触发切链）
3. !identityComplete   → "Fill in Agent Name, Ticker & valid Admin first"（禁用）
4. !saltLocked         → "Mine a hook salt first"（禁用）
5. !ack                → "Acknowledge the Immutable Pact first"（禁用）
6. feeMode:
     'loading'         → "Reading fee…"（禁用）
     'insufficient'    → "Insufficient ETH (need X ETH)"（禁用）
     'broadcasting'    → "⌛ Broadcasting transaction…"（禁用 + shimmer 动画）
     'confirmed'       → "✓ Launch confirmed! 0xabc…def"
     'launch'          → "Create Launch — pay X ETH"（可点）
```

`feeMode` 的推导（`:516-520`）：`isConfirmed → 'confirmed'`；`isPending||isConfirming → 'broadcasting'`；钱包未就绪或费用未读到 → `'loading'`；`ethBalance < launchFeeWei → 'insufficient'`；否则 `'launch'`。

**提交后**（`:551-580`）：解析 receipt 里的 `LaunchCreated` 事件取 `token`/`hook`；解析失败则回退到 `launchCount()` + `launches(count-1)` 读最后一条；然后 `POST /api/projects` 同步链下目录，状态条显示 `Syncing… / ✓ Directory synced / Directory sync deferred`。

### 6.5 客户端挖盐流程与缓存失效条件

**流程**（`handleMineSalt`，`soat-frontend/src/app/launch/page.tsx:484-505`）：

```
1. 前置：address && publicClient && treasury && adminAddr 都就绪
2. 现场读三个链上值（不用缓存的 useReadContracts 结果，避免过期）：
     liveSoftCap   = factory.defaultSoftCap()
     liveWalletCap = factory.maxPogAllocationLimit()
     initcodeHash  = factory.hookInitcodeHash(
                        treasury, address, adminAddr,
                        liveSoftCap, liveWalletCap, genesisDuration)
3. mineHookSalt(FACTORY_ADDRESS, address, initcodeHash)
     for i = 0 .. 500_000:
         rawSalt   = 32 字节零填充的 i
         finalSalt = keccak256(abi.encode(creator, rawSalt))
         addr      = "0xff" ++ factory ++ finalSalt ++ initcodeHash → keccak → 取低 20 字节
         if isValidHookAddress(addr): return { rawSalt, finalSalt, hookAddress }
     否则 throw "no valid salt found within 500000 attempts"
4. setSalt(rawSalt) + setPredictedHook(hookAddress)
```

矿机实现：`soat-frontend/src/app/lib/hookMiner.ts:128-143`（`computeCreate2Address` @ `:17-24`，`isValidHookAddress` @ `:27-35`，`deriveFinalSalt` @ `:105-115`）。这是 Solidity `HookMiner` 的逐行镜像，包括四条 return-delta 一致性规则。

**关键设计**：`initcodeHash` **从工厂链上读回**（`factory.hookInitcodeHash(...)`），而不是在前端本地重算。这消除了"字节码快照过期 → 挖出死盐"这一整类问题。

> **这段话本身值得记一笔。** 它原本还有个括号：「不过 `test/ToshV5Bytecode.t.sol` 仍在守护那个快照，说明它在别处仍被依赖。」那句推断是错的，而且错得很典型——**守卫的存在被当成了"被依赖"的证据**。实际上没有任何文件 import 过 `HOOK_BYTECODE`；它是 EIP-1167 克隆重构之前的遗留物，重构后 hook 的初始化码里装的是实现合约地址，前端再也不碰 hook 的创建码。
>
> 代价不是零：那个守卫、它的提取脚本、CI 步骤、`foundry.toml` 里为它开的权限，以及三处声称它至关重要的注释（其中一处是自动生成的，改了会被重新写回），合起来造成过一次数小时的 CI 红灯和一整轮元数据调查。快照、守卫、脚本与相关注释已于 2026-09-03 全部删除，详见 `PRE_MAINNET_CHECKLIST.md` §6.2。

**三处缓存失效条件**（任何一项变化都会让已挖的盐立即作废，因为它们都在 initcode hash 里）：

| 触发 | 处理 | 行号 |
|---|---|---|
| **连接钱包变化**（`address`） | `setSalt('')` + `setPredictedHook('')`。注释标为 `CRITICAL`：`address` 作为 `creator_` 传入 `hookInitcodeHash`，换钱包就换 hash | `:437-444` |
| **Project Admin 输入变化** | 同上，`onChange` 里直接清 | `:635-639` |
| **Genesis Window 切换** | 同上，`onChange` 里直接清（且 `next === genesisDuration` 时提前 return 避免误清） | `:653-661` |

**没有做的失效**：`defaultSoftCap` 或 `maxPogAllocationLimit` 被 owner 在"挖盐"与"提交"之间改动。这种情况下 `createLaunch` 会 revert `InvalidHookSalt`——测试 `test_createLaunch_revertsWhenSoftCapRotatedAfterMining` @ `test/ToshV5Factory.t.sol` 固化了这个行为。前端没有重试提示，用户只能重新挖盐。

**`createLaunch` 的调用参数**（`soat-frontend/src/app/lib/useTosh.ts:78-98`）：

```ts
writeA({
  functionName: 'createLaunch',
  args: [name, symbol, projectTreasury, projectAdmin, hookSalt, expectedFee, genesisDuration],
  value: expectedFee,      // 与 expectedFee 同值：既是滑点上限也是实付
  gas:   6_000_000n,       // 显式 gas 上限，绕过 eth_estimateGas
  chainId: BASE_SEPOLIA_ID,
})
```

显式 `gas` 的理由写在注释里（`:64-66`）：绕过 `eth_estimateGas`，避免 Base Sepolia 的 RPC 在模拟 revert 时抛出误导性的 "exceeds block gas limit"。Foundry 报这个调用约 3.7M gas，6M 留了充裕余量。

`useTosh` 用**两个独立的 `useWriteContract` slot**（A: `createLaunch`+`registerPoG`；B: `contribute`），让两条流的 `hash`/`isPending`/`error` 永不互相污染（`:26-31`、`:34-61`）。注：注释说 `registerPoG` 用 slot B（`:100-102`），但实现里用的是 `writeB`——与注释一致；而顶部注释说 slot A 是 `createLaunch + registerPoG`（`:34`），两处注释互相矛盾，实现以 `writeB` 为准。

### 6.6 项目终端 `ProjectTerminal`

#### 6.6.1 批量链上读取

`soat-frontend/src/components/ProjectTerminal/index.tsx` 的 `ProjectTerminal()` 中的 `bulkContracts`，单次 `useReadContracts` 拉 15 项（12s 轮询）：

`totalEthDeposited`、`launched`、`p0`、`phase2Minted`、`canRefund`、`genesisDeadline`、`softCap`、`BONDING_MAX`、`currentBondingPrice`、`ethDeposited(user)`、`factory.pogQuota(user)`、`factory.eligibility(user, hook)`、`factory.userLaunchCooldownEnd(user, hook)`、`shelfP0`、`factory.blacklistedUntil(user)`。

`projectToken` 单独读且 `staleTime: Infinity`——部署即固定，12s 轮询是浪费（同文件里紧跟 `bulkContracts` 之后的 `useReadContract`）。

类型显式声明为 `ContractFunctionParameters[]` 而非交给推断：HOOK_ABI 约 130 条，wagmi 的逐项映射类型会炸掉 TypeScript 的实例化深度上限（理由写在 `bulkContracts` 声明上方的注释里）。

#### 6.6.2 相位状态机

```ts
// ProjectTerminal/phase.ts 的 resolvePhase
function resolvePhase({ totalEthDeposited, softCap, canRefund, launched }): Phase {
  if (canRefund) return 'refund'
  if (launched || (softCap > 0n && totalEthDeposited >= softCap)) return 'bonding'
  return 'genesis'
}
```

| 相位 | 横幅标签 | 渲染的面板 |
|---|---|---|
| `genesis` | `[PHASE: GENESIS_LOCK_OPEN]` | `GenesisPanel` + 倒计时 |
| `bonding` | `[PHASE: SHELF_LADDER_LIVE]` | `BondingPanel`，且 `launched` 为真时追加 `LiquidityPanel` |
| `refund` | `[PHASE: GENESIS_FAIL_REFUND_OPEN]` | `RefundPanel` |

未连接钱包时统一渲染 `ConnectGate`（`:1516-1528`）。倒计时只在 `genesis` 相位显示，用提升到父组件的 `nowSec` 秒级时钟（`:1561-1565`，让 render 保持纯函数）。

> **⚠️ 8.6**：`resolvePhase` 在 `softCap` 达成但 `launched === false` 时就切到 `'bonding'`。此时：
> - `mintBondingCurve` 必定 revert `NotLaunched`（`src/ToshLaunchpadHook.sol:854`）；
> - 用户**失去了出资界面**，而创世窗口可能还没结束、链上还允许继续存（`GenesisPanel` 已被卸载）；
> - `LiquidityPanel` 因为有 `launched &&` 守卫（`:1764`）不会误显示，但阶梯面板会。
>
> 这是一个真实的 UI/链上语义错配窗口，窗口长度 = 从达成软顶到 creator 调 `launch()` 之间的时间（至少到 `genesisDeadline`，最长 7 天）。

#### 6.6.3 创世面板 `GenesisPanel`

`:701-854`。

**本地护栏**（在弹钱包之前拦住）：

| 检查 | 变量 | 锁定标签 | 行号 |
|---|---|---|---|
| 金额可解析且 > 0 | `amountInvalid` / `amountWei <= 0n` | `[deposit]` | `:705-710`、`:738` |
| 不超 PoG 剩余额度 | `quotaBreached = amountWei > quotaRemaining` | `[revert: quota_exceeded]` | `:712-715`、`:830-831` |
| 不超 ETH 余额 | `insufficientBal` | `[insufficient_balance]` | `:716`、`:834-835` |
| 冷却期已过 | `onCooldown = cooldownEnd > nowSec` | `[cooldown HH:MM:SS]` | `:717`、`:832-833` |

`armed`（按钮解锁）= 上述全部通过 && 已连接（`:764-769`）。

**UI 元件**：创世进度条（`totalEthDeposited / softCap`）、`QuotaLedger`（跨 hook 已存 / 额度 / 本次投影三档，投影超额时变红，`:354-432`）、ETH 余额与冷却期读数、带 `max` 按钮的金额输入（`max` = `min(quotaRemaining, ethBalance)`，`:809-823`）、`PogScanButton`（触发服务端签名 → `registerPoG`）。

**发起交易**（`handleDeposit`）：

```ts
writeDeposit({
  address: FACTORY_ADDRESS, abi: FACTORY_ABI,
  functionName: 'deposit',
  args: [p.hookAddress, p.referrer],     // ← 由 useBoundReferrer 提供
  value: amountWei,
  chainId: TARGET_CHAIN_ID,
})
```

> **✅ 8.3（已解决）**：推荐人一度被硬编码为 `ZERO_ADDRESS`，后果是经官方 UI 完成的每一笔创世出资、其 10% 都走 `orphanReferral` 进平台国库，一条完整实现的合约功能被前端整体旁路。现已打通：
> - `<ReferralCapture/>`（挂在 `app/layout.tsx`）在任意页面加载时解析 `?ref=<address>` 并落盘；
> - `useBoundReferrer`（`lib/useReferral.ts`）返回本地捕获值（首个链接先到先得，自荐则清空该槽位），没有则返回 `ZERO_ADDRESS`。它**不读链上 `referrerOf`**——该 view 只存在于 ABI 里，前端从未调用；也不需要读，因为 `deposit` 内部以 `globalReferrers[msg.sender]` 为准、`_recordReferral` 对已绑定钱包直接 return，所以一个过期的本地值无法覆盖链上既有绑定，链上始终是权威；
> - `ProjectTerminal` 将该地址作为 `deposit` 的第二个参数传入。
>
> **仍需知道的一条边界**：推荐人自己必须持有 PoG 额度（`pogQuota[referrer] > 0`），否则 `_recordReferral` 不予绑定、佣金照旧走 `orphanReferral`。这是防"自造二号钱包刷佣"的门槛，不是 bug；`ReferralPanel` 对尚未达标的分享者给出显式提示，避免其误以为链接已在计佣。

> **✅ 8.4（已解决）**：`claimReferralReward()` 已在 `ProjectTerminal` 的 `ReferralPanel` 接线，并带 `TxLine` 广播状态回显。

#### 6.6.4 阶梯面板 `BondingPanel` —— 报价与铸造

`:969-1176`。

**报价流水线**：

```
1. tierStatus() 轮询（8s）→ 取 unlocked（第 7 个返回值）
2. maxMintable() 轮询（8s）→ exceedsMax = tokenAmountWei > maxMintable
   注释明确：单次铸造上限不是 TIER_SIZE，而是 maxMintable() —— 它折叠了
   105% 门控、阶梯末端、MAX_TIERS_PER_TX 三重限制（:991-993）
3. quotable = tokenAmountWei > 0 && !exceedsMax
4. quoteMint(tokenAmountWei) 轮询（8s，仅 quotable 时 enabled）
5. isDust = quotable && !quoteFailed && ethCost === 0n        // L-01 dust 守卫
6. maxEthCost = ethCost + ethCost × SLIPPAGE_BPS / 10000      // +0.5%
7. insufficientBal = maxEthCost > ethBalance
8. gateLocked = tokenAmountWei > 0 && !unlocked
9. awaitingFirstUnlock = gateLocked && phase2Minted === 0n     // 区分"设计如此"与"故障"
```

**0.5% 滑点缓冲与合约退款找零**（`:65-67`、`:1017`、`:1048-1054`、`:1143-1145`）：

- `SLIPPAGE_BPS = 50n`，注释原文："Padded into the on-chain quote and sent as `msg.value`; excess ETH is refunded by the hook."
- `msg.value = maxEthCost`（含 0.5% 头寸），UI 在报价卡片底部明示：`msg.value = {maxEthCost} wei · excess refunded`。
- 合约侧对应的退款：`change = msg.value - cost; if (change > 0) _sendEth(msg.sender, change)`（`src/ToshLaunchpadHook.sol:922-923`）。
- 这个缓冲的必要性：`quoteMint` 是上一个区块的读，而 `mintBondingCurve` 在下一个区块执行，中间如果有别人抢先吃掉当前档的剩余，实际成交会跨到更贵的档。0.5% 覆盖这个滑移；不足则 revert `InsufficientPayment`。

**`handleMint` 的护栏顺序**（`:1039-1058`），每一条都有对应的锁定标签：

| # | 检查 | 错误文案 / 锁定标签 |
|---|---|---|
| 1 | 已连接 | "Connect wallet" |
| 2 | `tokenAmountWei > 0` | `[enter_amount]` |
| 3 | `!exceedsMax` | `"Exceeds what one call can serve — max X right now"` / `[exceeds_max_per_call]` |
| 4 | `!awaitingFirstUnlock` | `"Shelf 0 sits 5% over the pool — the ladder opens once the market holds at or above P₀"` / `[awaiting_market_above_p0]` |
| 5 | `!gateLocked` | `"105% price gate is locked — wait for spot/TWAP"` / `[gate_locked]` |
| 6 | `!isDust` | `[invalid_amount]` |
| 7 | `!insufficientBal` | `"Insufficient ETH for quoted cost + slippage"` / `[insufficient_eth]` |

第 4 条特别值得注意：注释解释了为什么要把它与第 5 条分开——**在任何人铸造之前，门关着是设计的开盘状态，不是故障**，所以文案要陈述事实而不是报警（`:1021-1023`）。这直接对应 5.1/3.3 里 `SHELF_PREMIUM_BPS == PRICE_CEILING_BPS` 的设计。

**`ShelfLadder` 子组件**（`:440-539`）：

- 读 `tierStatus()`（7 元组全用上）+ `getTiers(windowStart, 5)`，窗口以当前档为中心（`windowStart = max(tierIndex - 2, 0)`，`:464`）。
- 顶栏显示 `GATE OPEN` / `GATE LOCKED · 105%`。
- 四个读数：ACTIVE SHELF `#i / 4000`（分母直接取链上 `TIER_COUNT`）、SHELF PRICE、REMAINING、105% CEILING（解锁时用 fluo 色）。
- 当前档填充进度条。
- 5 行档位表：`#索引 / 价格 / 已售% / LIVE|CLEARED|QUEUED`。
- 底栏：`P₀ = … / spot = … / twap = …`（把三个价格摆在一起，让用户自己看门控逻辑）。

**四个读数栏**（`:1084-1097`）：`P₀ · POOL OPEN`、`SHELF 0 · +5%`（提示 "mint premium over market"）、`ACTIVE SHELF`（提示 `X× ladder base`）、`PHASE-2 MINTED`（`phase2Minted / bondingMax`，提示 `4000 shelves × 3.15K`，即 `TIER_COUNT × TIER_SIZE`）。

注意 `premiumRaw` 是相对 **`shelfP0`** 而非 `p0` 计算的（`:1063-1066`），注释理由："Measured against the LADDER base rather than the pool's opening price, so the flat 5% mint premium does not masquerade as ladder progress."

**事件流 `RecentEventsTicker`**（`:552-661`）：`useWatchContractEvent` 订阅 `Deposited` / `TierMinted` / `Refunded`，环形缓冲 24 条，带 basescan 链接。

#### 6.6.5 散户 LP 极简全区间面板 `LiquidityPanel`

`:1197-1456`。面板头部注释（`:1178-1189`）说明了范围界定：hook 故意把 `BEFORE_REMOVE_LIQUIDITY` 留在掩码之外，所以散户 LP 本来就能自由进出——**缺的是一扇前门**：posm 仓位是藏在 Permit2 授权舞步后面的 ERC-721，不是零售用户会手工组装的东西。**范围刻意只做一个区间**：与创世仓位相同的全区间。做区间选择器就得教用户理解 tick，而集中流动性的 LP 已经有专门工具了。

**存入 ETH + 代币**：

```
1. useLpPoolState(token, hook) → sqrtPriceX96, totalLiquidity（经 STATE_VIEW 读）
2. tokenNeeded = pairedAmount1(sqrtPriceX96, ethWei)     // 向上取整
3. ethMax   = ethWei      × 1.005
   tokenMax = tokenNeeded × 1.005                        // 同样 0.5% 头寸
4. liquidity = liquidityForAmounts(sqrtPriceX96, ethWei, tokenNeeded)  // 取绑定侧
5. encodeMintPayload → posm.modifyLiquidities(unlockData, deadline) with value: ethMax
```

`pairedAmount1` 的取整方向是**刻意的**（`soat-frontend/src/lib/v4Math.ts:123-140`）："Rounds UP: under-quoting the token side makes the mint revert on the `amount1Max` guard." 对应地，`amountsForLiquidity` 向下取整，"matching what the pool actually pays out on a burn, so the panel never shows a number the user cannot withdraw"（`:82-87`）。

`SQRT_PRICE_LOWER = 4_310_618_292n` / `SQRT_PRICE_UPPER = 1_456_195_216_270_955_103_206_513_029_158_776_779_468_408_838_535n` 是 `TickMath.getSqrtPriceAtTick(∓887200)` 对 v4-core 实跑的结果，不是浮点近似（`soat-frontend/src/lib/v4Math.ts:1-18`）。

这两个常数、以及 `amountsForLiquidity` / `liquidityForAmounts` / `pairedAmount1` 三个函数，由 `soat-frontend/scripts/checkV4Math.ts`（`npm run guard:v4math`，跑在 `frontend.yml`）对着 Foundry 实跑记录下来的向量校验。这里的漂移不会抛异常，只会让面板报出一个池子不肯接受的数额——用户已经签完两次 Permit2 授权之后，mint 才在 `amount1Max` 上 revert。

**posm action payload**（`soat-frontend/src/lib/lpActions.ts`）：

| 操作 | opcode 序列 | 说明 | 行号 |
|---|---|---|---|
| 存入 | `MINT_POSITION(0x02)` + `SETTLE_PAIR(0x0d)` + `SWEEP(0x14)` | `SWEEP` 把池子没取走的 ETH 退回来，所以调用方可以安心把 `amount0Max` 当 `msg.value` 发出去 | `:41-76` |
| 撤出 | `BURN_POSITION(0x03)` + `TAKE_PAIR(0x11)` | 关仓并两侧付出 | `:78-100` |

文件头注释（`:1-21`）解释了为什么这必须是独立的纯函数而不是内联在组件里：
- `CalldataDecoder.decodeActionsRouterParams` 强制**严格** ABI 编码——它会重算每个偏移量，任何偏离（包括某些编码器产出的合法但非规范布局）都会 revert；
- `decodeMintParams` 按**硬编码 calldata 偏移**读字段，所以参数表必须精确产出它期望的 head 布局（`PoolKey` 元组是静态的、占 slot 0..4，这就是 `hookData` 落在 slot 11 的原因）。
- 两条性质由一对互补的守卫共同钉住，**都已接入 CI**：
  - `soat-frontend/scripts/checkLpActions.ts`（`npm run guard:lpactions`，跑在 `frontend.yml`）驱动真实的 viem 编码器，逐字节检查它吐出的 payload；
  - `scripts/checkLpActionsAbi.mjs`（跑在 `test.yml`，因为它要读 `lib/`）解析 `lib/v4-periphery` 的 `CalldataDecoder.sol` / `Actions.sol` 与 `lib/v4-core` 的 `PoolKey.sol`，要求上面那个守卫里的字面量、`V4_ACTIONS` 和 `MINT_PARAM_SPEC` 与真实 Solidity 逐项对齐。

  之所以要拆成两半：前者是唯一能检查真实编码器输出的一半，但它只能拿自己文件里写着的偏移量去比，**并不是**对着真实解码器断言——曾经它连 opcode 都是拿 `V4_ACTIONS` 去比 `V4_ACTIONS`（payload 正是由它编出来的），任何取值都能通过。实测：把 `lib/v4-periphery` 里 `decodeMintParams` 的偏移整体挪一格，它照样报 "All posm payload invariants hold"。后者补的就是这个洞。两半缺一不可。

  （历史：`checkLpActions.ts` 与 `checkV4Math.ts` 此前都在用法行里写 `npx tsx`，而 `tsx` 从来不是本仓依赖，所以两个都跑不起来、也没接进 CI——和 `.github/workflows/test.yml` 里记的 `checkHookMinerTuple.mjs` 事故同型。现在改由 `soat-frontend/scripts/runTsGuard.mjs` 用仓内已有的 `typescript` 转译执行，没有引入新依赖；`npm run guards` 一条命令跑齐前端侧的三个守卫。）

**Permit2 三步授权引导流程**（`:1355-1365`）——一次只暴露一个活跃步骤，让 CTA 永远精确说明"下一次签名做什么"，而不是一次甩三个按钮给用户：

```
if (!isConnected)          → "Connect wallet to provide liquidity"（禁用）
if (!tokenAddress)         → "Token not resolved yet"（禁用）
if (ethWei <= 0)           → "Enter an ETH amount"（禁用）
if (ethInvalid)            → "Invalid amount"（禁用）
if (insufficientEth)       → "Insufficient ETH"（禁用）
if (insufficientToken)     → "Insufficient {SYMBOL}"（禁用）
if (needsErc20Approval)    → "Step 1 of 3 — approve {SYMBOL} for Permit2"
                              → token.approve(PERMIT2, MAX_UINT160)
if (needsPermit2Approval)  → "Step 2 of 3 — let Permit2 fund the position manager"
                              → PERMIT2.approve(token, POSITION_MANAGER, MAX_UINT160,
                                                now + 30 days)
else                       → "Step 3 of 3 — deposit into the pool"
                              → posm.modifyLiquidities(..., value: ethMax)
```

授权状态判定（`:1249-1252`）：
- `needsErc20Approval = tokenMax > 0 && erc20.allowance(user, PERMIT2) < tokenMax`
- `needsPermit2Approval = tokenMax > 0 && (!posmAllowance || posmAllowance[0] < tokenMax || posmAllowance[1] <= nowSec)` —— Permit2 额度是 `uint160` 且**自带过期时间**，所以要同时看额度和到期（`:1192-1195`）。

常量：`MAX_UINT160 = 2^160 - 1`、`PERMIT2_TTL_SECONDS = 30 天`、`TX_DEADLINE_SECONDS = 20 分钟`（`:1193-1195`）。

**撤出**（`:1334-1351`）：

```ts
encodeBurnPayload({
  tokenId,
  amount0Min: amount0 − amount0 × 50 / 10000,   // 0.5% 下滑保护
  amount1Min: amount1 − amount1 × 50 / 10000,
})
```

> **⚠️ 8.23**：`amount0` / `amount1` 是前端用本地 `amountsForLiquidity(sqrtPriceX96, liquidity)` 算出来的。如果 RPC 返回的 `sqrtPriceX96` 滞后于链上真实价格（12s 轮询），这个 0.5% 的滑点下限要么让撤出 revert，要么形同虚设（因为基准本身就是错的）。

**仓位发现**（`soat-frontend/src/lib/useLpPosition.ts`）——文件头把难点说得很清楚（`:6-20`）：V4 仓位是 posm 持有的 ERC-721，而 **posm 不是 `ERC721Enumerable`**——没有 `tokenOfOwnerByIndex`，periphery 里也没有任何"按 owner + pool 查仓位"的 view。所以从两个来源重建并合并：

1. posm 的 `Transfer(_, to = user, id)` 日志。权威，但公共 RPC 对日志查询有限流和范围上限，所以在有界回溯窗口内做、允许静默失败。回溯 `LOG_LOOKBACK_BLOCKS = 600,000`（Base 约 2s/块 ≈ 两周），分片 `LOG_PAGE_SIZE = 50,000`（`:31-36`、`:139-154`）。
2. 本 UI 每次铸仓时写的 `localStorage` 缓存（`rememberLpPosition`，`:41-52`）。覆盖"刚铸好、RPC 日志索引没跟上"和"回溯窗口已滚过铸造点"两种情况。

**每个候选都会链上校验**（`ownerOf` == user、`getPoolAndPositionInfo().hooks` == 本 hook、`getPositionLiquidity() != 0`，`:165-181`），所以过期或恶意的缓存条目最多只会浪费一次读，绝不会算出错的余额。

日志扫描失败时设 `degraded = true`（`soat-frontend/src/lib/useLpPosition.ts`），面板显示降级提示（`ProjectTerminal/LiquidityPanel.tsx` 里的 `degraded` 分支）："this RPC would not serve position logs, so only positions minted from this browser are listed. Your other positions are safe on-chain and remain withdrawable through any Uniswap V4 interface."

**四个读数栏**（`:1373-1386`）：POOL DEPTH · ETH / POOL DEPTH · {SYMBOL}（提示 "all LPs incl. genesis"）/ MY POSITION · ETH / MY POSITION · {SYMBOL}（提示 "withdrawable any time"）。开仓列表逐行显示 `#tokenId · X ETH + Y SYMBOL` 加一个 `Withdraw` 按钮。

面板副标题：`"Uniswap V4 PositionManager · full range · 0.30% pool fee accrues to LPs"`（`:1371`）。

#### 6.6.6 退款面板 `RefundPanel`

`:1462-1510`。副标题：`"hook.refund() — soft-cap not met OR zombie window elapsed · full claim, no penalty"`。锁定标签在 `ethDeposited === 0n` 时显示 `[no_deposit]`，否则 `[claim_refund]`。

#### 6.6.7 前端未覆盖的合约入口

| 合约函数 | 前端状态 | 影响 |
|---|---|---|
| `hook.launch()` | **⚠️ 8.5：无任何 UI 入口。** 全仓搜索 `functionName: 'launch'` 只命中 ABI JSON | creator 必须自己用 `cast send` / Etherscan / 自建脚本开盘。这是整个生命周期的**关键路径**，却没有产品化 |
| `hook.claimReferralReward()` | **⚠️ 8.4：无 UI 入口** | 推荐佣金无法通过 UI 领取（配合 8.3，实际也累积不到） |
| `hook.changeProjectAdmin()` | 无 UI 入口 | 管理员轮换需手工发交易 |
| `treasury.addLadderToken()` / `removeLadderToken()` | 无 UI 入口（`/admin` 只有工厂的 owner 函数，见 `soat-frontend/src/app/admin/page.tsx` 的 13 处 `functionName`） | 回购策展需手工发交易 |
| `hook.claimGenesis()` | ✅ 在 `UserDrawer`（`:655`）与 `useContractActions.genesisClaim`（`:90`） | — |

### 6.7 PoG 签名链路（前端 ↔ 服务端）

| 环节 | 位置 | 说明 |
|---|---|---|
| 会话授权签名 | `ProjectTerminal/PogScanButton.tsx` + `ProjectTerminal/pogAuthCache.ts`、`buildPoGScanAuthMessage`（`soat-frontend/src/lib/contracts.ts`） | 消息格式 `"Tosh PoG Scan Request\nAddress: {addr}\nTimestamp: {ms}"`，签名缓存在 `sessionStorage`，TTL `POG_SESSION_AUTH_TTL_MS = 1,800,000`（30 分钟） |
| 服务端签发 | `soat-frontend/src/app/api/sign-allocation/route.ts`、`api/admin/config/route.ts`、`app/lib/pogQuota.ts`、`app/lib/onchainNonce.ts` | 服务端持 `POG_SIGNER_PRIVATE_KEY`；nonce 从链上 `factory.pogNonces(sender)` 现读（README §5 描述） |
| 链上提交 | `useTosh.registerPoG`（`:103-118`） | `args: [maxAlloc, deadline, nonce, signature]` |

---

## 7. 附录：常量、事件、错误码总表

### 7.1 常量总表

#### `ToshLaunchpadHook`

| 常量 | 值 | 行号 |
|---|---|---|
| `GENESIS_SUPPLY` | 8,400,000e18（占硬顶 40%） | 139 |
| `GENESIS_CLAIM_SUPPLY` | 4,620,000e18（创世块的 55%） | 161 |
| `GENESIS_LP_SUPPLY` | 3,780,000e18（创世块的 45%） | 162 |
| `TIER_COUNT` | 4000 | 165 |
| `TIER_SIZE` | 3,150e18 | 169 |
| `BONDING_MAX` | 12,600,000e18（占硬顶 60%） | 172 |
| `TIER_STEP_E18`（internal） | 1,001,902,508,266,805,824（跨度 2000×） | 186 |
| `MAX_TIERS_PER_TX` | 32 | 200 |
| `DURATION_FAST` / `_STANDARD` / `_SLOW` | 3h / 24h / 72h | 214-216 |
| `LAUNCH_WINDOW` | 7 days | 218 |
| `REFERRAL_BPS` | 1000（10%） | 226 |
| `PLATFORM_TAX_BPS` | 100（1%） | 230 |
| `TAX_BPS` | 70（0.70%） | 239 |
| `BPS_DENOMINATOR`（internal） | 10,000 | 241 |
| `PRICE_CEILING_BPS` | 10,500（105%） | 247 |
| `SHELF_PREMIUM_BPS` | 10,500（105%） | 279 |
| `TWAP_WINDOW` | 1800（秒；实测窗口漂移于 [1800, 3600)） | 284 |
| `POOL_FEE` | 3000（0.30%） | 302 |
| `TICK_SPACING` | 200 | 309 |
| `TICK_LOWER` / `TICK_UPPER`（internal） | −887,200 / +887,200 | 311-312 |
| `DEAD_ADDRESS` | `0x…dEaD` | 314 |
| `ACTION_ADD_LIQUIDITY`（internal） | 1 | 316 |
| `PIGGYBACK_TRIGGER_STEP` | 1 ether | 国库 `TRIGGER_STEP` 的本地副本，省一次跨合约读；`test_piggybackTriggerMirrorsTheTreasury` 钉住两者不漂移 |
| `PIGGYBACK_MIN_GAS` | 230,000 | poke 所需的最低 `gasleft()`。标定见 8.34 |
| `PIGGYBACK_TAIL_RESERVE` | 100,000 | 物理扣给收尾（`afterSwap` 返回 + V4 关帧 + router 结算，实测约 70k）的份额 |

**Phase-2 阶梯状态是打包的**：`currentTierIndex` / `currentTierSold` / `phase2Minted` 三个原本各占一个槽的 `uint256` 公开字段，现合并为内部结构体 `LadderState { uint16 tierIndex; uint88 tierSold; uint96 minted; }`（单槽，25 字节）。三个公开 getter 手写保留，**ABI 未变**。位宽由本表的常量证明——`TIER_COUNT ≤ 65,535`、`TIER_SIZE ≤ 2^88`、`BONDING_MAX ≤ 2^96`——并由 `test_ladderStateWidthsFitTheirConstants` 守住：Solidity 不检查显式向下转型，所以常量涨过字段会**静默截断**而不是 revert，后果是阶梯把已售货架重新开卖。`mintBondingCurve` 因此从 197,195 降到 173,550。

#### `ToshFactory`

| 常量 / 默认值 | 值 | 行号 |
|---|---|---|
| `MAX_SIG_VALIDITY` | 24 hours | 42 |
| `MAX_COOLDOWN` | 7 days | 43 |
| `MIN_SOFT_CAP_PROD` | 0.01 ether | 55 |
| `cooldownDuration`（默认） | 24 hours | 75 |
| `launchFee`（默认） | 0.1 ether | 78 |
| `maxPogAllocationLimit`（默认） | 0.1 ether | 89 |
| `defaultSoftCap`（默认） | 10 ether | 92 |
| 黑名单批量上限 | 200 | 264、273 |

#### `ToshLadderTreasury` / `ToshToken` / `HookMiner`

| 常量 | 值 | 说明 |
|---|---|---|
| `TRIGGER_STEP` | 1 ether | 武装阈值 |
| `SPEND_BPS` | 1000 | 每周期投放 `max(TRIGGER_STEP, 余额 × 10%)`（8.10） |
| `BATCH_SIZE` | 3 | **分仓除数**：`perToken = spend / BATCH_SIZE`。已不再是每次 poke 的腿数 |
| `LEGS_PER_POKE` | 1 | 每次 poke 的腿数。与上一行拆开是 8.33 的修法 |
| `MAX_BUYBACK_SQRT_DEVIATION_BPS` | 1000 | TWAP 下限，SQRT 口径（≈19% 价格） |
| `_PIGGYBACK_SLOT` | `0x546f73685069676779626163b1000001` | EIP-1153 瞬态标记 |
| `MAX_SUPPLY` | 21,000,000e18 | `ToshToken.sol:53` |
| `MINTER_ROLE` | `keccak256("MINTER_ROLE")` | `ToshToken.sol:47` |
| `REQUIRED_FLAGS` | `0x20CC` | `HookMiner.sol:64-65` |
| `ALL_HOOK_MASK` | `0x3FFF` | `HookMiner.sol:46` |

### 7.2 事件总表

| 合约 | 事件 | 行号 |
|---|---|---|
| Hook | `TokenInitialized` / `Deposited` / `Launched` / `GenesisFailed` / `ZombieRefund` / `Refunded` / `GenesisShareClaimed` | 440-446 |
| Hook | `ReferralAccrued` / `ReferralClaimed` / `OrphanReferralForwarded` / `ProjectAdminChanged` | 447-450 |
| Hook | `TierMinted(buyer, tierIndex, tierPrice, tokensOut, ethIn)` / `TierAdvanced(newTierIndex, newTierPrice)` | 453-458 |
| Hook | `BuyTaxToTreasury(ethAmount)` / `SellTaxBurned(tokenAmount)` / `PiggybackPokeFailed(treasury)` | 461-469 |
| Factory | `LaunchCreated` / `Blacklisted` / `PoGRegistered` / `GenesisDeposit` / `ReferralBound` | 147-158 |
| Factory | `PogSignerUpdated` / `TreasuryUpdated` / `LaunchFeeUpdated` / `LaunchFeeForwarded` / `CooldownDurationUpdated` / `DefaultSoftCapUpdated` / `MaxPogAllocationLimitUpdated` / `QuotaWindowReset` | 159-168 |
| Treasury | `FactorySet` / `LadderTokenAdded` / `LadderTokenRemoved` / `TaxReceived` / `PiggybackExecuted` / `BuybackBurned` / `BuybackSkipped` | 110-123 |

**`PiggybackExecuted` 的频率变了**：`LEGS_PER_POKE = 1` 之后它每条腿发一次，而不是每三条腿一次。同样的 ETH，三倍的事件数——按旧节奏调过阈值的告警规则会把这读成回购风暴。

**没有「poke 被跳过」的事件**，这是故意的：跳过是常态，记日志要让每个交易者掏钱。所以 gas 门控造成的储备闲置对任何事件订阅都是不可见的，只能靠 `STATE-06` 轮询余额。

### 7.3 错误码总表（面向前端文案）

#### Hook（`src/ToshLaunchpadHook.sol:475-527`）

| 错误 | 触发条件 | 建议文案 |
|---|---|---|
| `OnlyPoolManager` / `OnlyFactory` / `OnlyCreator` / `Unauthorized` | 调用方不对 | 内部错误 |
| `NotInitialized` / `AlreadyInitialized` | 代币未绑定 / 已绑定 | 内部错误 |
| `GenesisActive` | 创世窗口未结束就 `launch()` | "创世窗口还没结束" |
| `GenesisExpired` | 窗口已结束还在存 | "创世已截止" |
| `AlreadyLaunched` / `NotLaunched` | 相位错 | — |
| `AlreadyClaimed` / `NoDeposit` | 已认领 / 无出资 | — |
| `SoftCapNotMet` | 软顶未达成就开盘 | "软顶未达成" |
| `LaunchWindowExpired` | 超 7 天僵尸窗口 | "发射窗口已过期，储户可退款" |
| `InvalidDuration` | 创世时长不在 {3h,24h,72h} | "创世时长必须是 3/24/72 小时" |
| `InvalidAdmin` | `projectAdmin == 0` | "项目管理员不能为零地址" |
| `LadderExhausted` | 全部 2000 档售罄 | "阶梯已耗尽" |
| `ExceedsTierRemaining` | 订单越过阶梯末端 | "订单超出剩余供应"（⚠️ 8.15） |
| `SpanTooManyShelves` | 跨档 > `MAX_TIERS_PER_TX`（32） | "拆成两笔发送，终态相同" |
| `SameBlockMintForbidden` | 本区块内有过 swap | "等一个区块" |
| `TierPriceAboveCeiling` | 档价 > 105% 参考价 | "价格门锁定，等二级市场跟上" |
| `InsufficientPayment` | `msg.value < cost` | "滑点不足，重新报价" |
| `NoReferralReward` | 无累积佣金 | — |
| `PerWalletCapExceeded` | 超本项目每钱包上限 | "已达本项目单钱包上限" |
| `EthTransferFailed` / `UnknownAction` / `UnauthorizedInitialization` / `ZeroAmount` | — | — |

#### Factory（`src/ToshFactory.sol:172-195`）

`IsBlacklisted` / `NoPogQuota` / `QuotaExceeded` / `CooldownActive` / `InvalidSignature` / `NonceConflict` / `SignatureExpired` / `SignatureTooLong` / `HookNotRegistered` / `InvalidHookSalt` / `DeployFailed` / `ZeroAmount` / `InvalidAdmin` / `ExceedsGlobalPogLimit` / `InvalidSoftCap` / `NameTaken` / `EmptyName` / `InsufficientLaunchFee` / `FeeChanged` / `EthTransferFailed`

#### Treasury

`OnlyHook` / `OnlySelf` / `OnlyPoolManager` / `FactoryAlreadySet` / `FactoryNotSet` / `ZeroAddress` / `TokenAlreadyListed` / `TokenNotListed` / `TokenNotLaunchedHere` / `InvalidPoolKey` / `PoolNotLaunched` / `NotArmed` / `PiggybackInProgress`

三个值得单独说明：

| 错误 | 何时 | 面向用户的文案 |
|---|---|---|
| `NotArmed` | `pokeBuyback()` 时储备低于 `TRIGGER_STEP` 或挂牌列表为空 | "国库尚未攒够，无需触发" |
| `PiggybackInProgress` | 同一调用栈里已有回购在跑 | "回购正在进行中" |
| `PoolNotLaunched` | `addLadderToken` 挂一个尚未 `launch()` 的项目。与 `InvalidPoolKey` 不同——hook 存在、`PoolKey` 也构造良好，只是背后还没有池子。存储打包移除 `_poolKey` 后，`getPoolKey()` 不再对未发射项目返回零值，所以这条检查改为显式读 `launched()` | "该项目还未开盘" |

#### Token（`src/ToshToken.sol:67-69`）

`OnlyFactory` / `AlreadyInitialized` / `MaxSupplyExceeded`

### 7.4 部署脚本对照

| 脚本 | 用途 | 关键动作 |
|---|---|---|
| `script/Deploy.s.sol` | Base Sepolia | Treasury → Factory → `setFactory`；打印 `getLiveHookInitcodeHash` 与 6 条后续步骤（含"掩码现在是 0x20CC"、"createLaunch 现在 payable"、"deposit 现在 payable，无需 approve"） |
| `script/DeployMainnet.s.sol` | 生产 | 所有 env 必填无默认；强制 `PROD_OWNER_SAFE != deployer`；两步移交工厂 + 国库；打印 `HOOK_CREATION_CODEHASH` / `LIVE_INITCODE_HASH` / 三个 wei 级默认值 + 6 条 CRITICAL NEXT STEPS |
| `script/DeployLocal.s.sol` | anvil | Anvil 账户 #0；`V4_POOL_MANAGER` 缺省为 `address(1)` 桩（够跑工厂级流程：PoG、推荐绑定、资格） |
| `script/VerifyDeployment.s.sol` | 部署后不变量巡检 | 6 类断言，含 `treasury.factory() == factory`、`!paused()`、`initcodeHash` 同块可重复性；支持 `EXPECTED_OWNER` / `EXPECTED_POG_SIGNER` / `EXPECTED_PLATFORM_TREASURY` 严格交叉校验 |
| `script/RecomputeInitcodeHash.s.sol` | 重播种前端矿机 | 只读；导出可直接粘贴的 JSON；明确提示"这是 24h STANDARD 窗口的 hash，3h/72h 哈希不同，矿机必须按创作者选的窗口重建" |

### 7.5 测试套件到需求的映射（v5.0 验收）

| 需求 | 测试 | 位置 |
|---|---|---|
| 10% 创世溢价（关系而非硬编码） | `test_genesisPremium_isExactlyTenPercent` | `test/ToshV5.t.sol` |
| 开盘时阶梯完全关闭 | `test_ladderOpensLockedAtLaunch` | `:858` |
| 阶梯几何（4000 档 / 4200 / 2000× 跨度） | `test_tierLadder_geometryIsWellFormed` | `:688` |
| 早期放量时间表（2× 解锁 365 档 = 1.14975M = 创世盘 13.7%） | `test_earlyReleaseSchedule_isSetByTheSupplySplit` | `test/ToshV5.t.sol` |
| 跨档 ≡ 逐档 | `test_tierMint_spanIsEquivalentToSequentialShelfBuys` | `:755` |
| `maxMintable()` 是精确边界 | `test_maxMintable_isTheExactAcceptedBoundary` | `:789` |
| 腿数上限是 gas 而非安全 | `test_tierMint_legCapBindsWhenMarketRunsAhead` | `:816` |
| 即时铸造砸盘亏钱 | `test_sweepAndDumpIsLossMaking` | `:885` |
| **市场先涨后扫货赚钱（接受的代价）** | `test_sweepIsProfitableOnceTheMarketHasRunAhead` | `:932` |
| 同区块锁 + 105% 门控 | `test_tierMintAntiSpikeAndCeiling` | `:967` |
| TWAP 击败单区块拉盘 | `test_tierMint_twapDefeatsASingleBlockPump` | `:1006` |
| 开盘窗口参考价封顶 p0 | `test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump` | `:899` |
| 买入侧税进国库 | `test_buyTax_skimsSeventyBpsEthToLadderTreasury` | `:1033` |
| 卖出侧税就地销毁 | `test_sellTax_burnsSeventyBpsOfTokensInPlace` | `:1046` |
| 创世 LP 永久锁定 | `test_genesisLiquidityIsPermanentlyLocked` | `:613` |
| 散户 LP 自由进出且不影响创世 | `test_retailLp_canAddAndRemoveWithoutTouchingGenesis` | `:633` |
| 顺风车轮转回购 | `test_treasuryPiggybackRoundRobin` | `:1110` |
| 单腿故障隔离 | `test_piggyback_isolatesAFaultyLadderLeg` | `:1173` |
| 每次 poke 一条腿，但仍覆盖整个阶梯 | `test_piggybackRunsOneLegPerPokeAndStillCoversTheLadder` | 8.33 |
| 一条腿的边际 gas，且不随阶梯长度增长 | `test_gas_piggybackCostPerLeg` | 8.33 |
| **预算紧时回购让路，交易不死** | `test_piggybackSkipsRatherThanKillingTheTrade` | 8.32 |
| **推过阈值的那笔交易按自己的估算成交** | `test_piggybackSparesTheTradeThatTipsIt` | 8.32 |
| 诚实估算的交易仍带得上回购（门控没订过高） | `test_piggybackStillRidesAProperlyEstimatedSwap` | 8.34 |
| 无许可 `pokeBuyback()` 不靠 swap 就能投放 | `test_pokeBuyback_deploysWithoutASwap` | 8.32 |
| 未武装 / 空名单时 `pokeBuyback` 明确 revert | `test_pokeBuyback_revertsWhenUnarmed` / `_revertsWithAnEmptyLadder` | 8.32 |
| fuzz handler 真能走到 `pokeBuyback`（不变量非空转） | `test_handlerCanReachPokeBuyback` | 8.32 |
| 打包字段宽度仍容得下各自的常量 | `test_ladderStateWidthsFitTheirConstants` | §7.1 |
| 国库无提现路径 | `test_ladderTreasury_hasNoWithdrawPath` | `:1196` |
| **owner 无法把支出导向自己的池子** | `test_ladderTreasury_ownerCannotRedirectSpendToOwnPool` | `:1216` |
| 策展拒绝外部代币 / 未开盘项目 | `test_ladderCuration_rejectsForeignTokens` / `_rejectsUnlaunchedProjects` | `:1089` / `:1099` |
| PoG 额度不因退款恢复 | `test_pogQuota_isNotRestoredByRefund` | `:425` |
| PoG 额度按窗口续期 | `test_pogQuota_refillsAfterTheCooldownWindow` | `:450` |
| 每钱包上限在创建时快照 | `test_perWalletCap_isSnapshottedAtProjectCreation` | `:396` |
| 全局推荐持久化 / 自我推荐被忽略 | `test_globalReferralPersistence` / `_selfReferralIsIgnored` | `:497` / `:524` |
| 孤儿佣金转入国库 | `test_orphanReferralIsForwardedToLadderTreasuryAtLaunch` | `:537` |
| 掩码 = `0x20CC` | `test_minedHookAddress_carriesV5FlagMask` / `test_hookMiner_requiredFlagsAre0x20CC` | `:314` / `Guards` |
| 三档窗口接受 / 未列窗口拒绝 / 跨窗口盐拒绝 | `Guards:184` / `Guards:206` / `Factory:928` | — |
| 供应切分闭合 / 硬顶 21M | `test_supplyPartitioning` / `test_tokenMaxSupply_is21M` | `Guards:458` / `:464` |
| 铸币权永久冻结在 Hook | `test_token_minterSetIsFrozenAtOneAddress` | `Guards` |

---

## 8. 已关闭条目记录

> 本章条目已全部关闭。关闭记录保留原编号以便回溯。行号对应 2026-08-25 落地后的文件状态。

### 8.0 已关闭条目（原编号 → 处置）

| 原编号 | 条目 | 处置 |
|--------|------|------|
| 8.1 | `projectTreasury` 是纯元数据 | **保留代码，改文档**。它是 CREATE2 构造元组的一员，改名或移除都会让已挖的盐全部失效（连改注释都会——见 8.13），而经济收益为零。natspec 已明确标注「此地址永不收款，找钱请看 `projectAdmin` 与 `ladderTreasury`」 |
| 8.2 | `platformTreasury` 也没有资金流 | 同上，改文档。已在 `ToshFactory` natspec、`.env.example`、`.env.production.example`、admin 面板标题、`INCIDENT_RESPONSE.md` 五处标注为 v4.x 遗留、不在资金路径上。考古确认 v4.x 时它确实收 2% Phase-2 SATO，v5.0 改道 `ladderTreasury` 时被遗留 |
| 8.3 | 推荐人硬编码零地址 | **已修**。新增 `soat-frontend/src/lib/useReferral.ts`：`?ref=` 校验 + 校验和化 + localStorage 首写优先；`<ReferralCapture/>` 挂在根布局，任意页面落地都能捕获；自荐在 spend 时清除存储而非忽略，避免用户点自己的链接测试后永久占住唯一的绑定名额 |
| 8.4 | `claimReferralReward()` 无 UI | **已修**。`ReferralPanel` 读 `claimableReferral`，连接钱包即显示（佣金为零也显示，否则用户找不到自己的链接） |
| 8.5 | `hook.launch()` 无 UI | **已修**。`AwaitingLaunchPanel` 提供 creator 专属入口，并明示不开盘则 7 天后全员退款 |
| 8.6 | 相位在「软顶达成未开盘」时错切 | **已修**。新增 `awaiting-launch` 相位；出资面板改为只看窗口不看软顶，超额认购时显示提示但不关闭入口 |
| 8.9 | 105% 门控让 5% 溢价对消 | **作为设计接受**。产品方确认这正是货架追踪市价的机制。行为由 `test_sweepIsProfitableOnceTheMarketHasRunAhead` 钉住。量化精度仍不足，见 8.7 |
| 8.16 | `ToshToken` 注释说供应渐近 | **已修**。离散阶梯 4000 × 3,150 精确可清空，总供应可真正到达 21M，注释已改写 |
| 8.17 | `ToshToken` natspec 停留在 v4.0 | **已修**。整段重写。同时**删除了 `renounceMinterRole()`**：`MINTER_ROLE` 只属于 hook，而 hook 无任何调用它的代码路径，也无 delegatecall / 任意调用转发，所以部署后无人能触发——原测试通过仅因 `vm.prank(address(hook))` 伪造调用者。一个有文档、有测试背书、实际不存在的安全控制比没有更危险。替换为 `test_token_minterSetIsFrozenAtOneAddress`，验证 `DEFAULT_ADMIN_ROLE` 槽位空置导致铸造者集合永久冻结。**铸币权不可迁移 / 无代理是故意的 Immutable Pact**：逻辑缺陷不能靠换 v5.1 Hook 补救，未售完阶梯永远无法二次铸出。已在 `ToshToken` natspec、README、发射页《Immutable Pact》高亮声明 |
| 8.18 | README 停留在 v3.4 | **已修**。整份重写为 v5.0 |
| 8.19 | 发射台写 98% | **已修**，改为 99% |
| 8.26 | PoG 命名不统一 | **并入 8.15**，统一为 Proof-of-Gas |
| 8.27 | `useTosh` slot 注释矛盾 | **已修**，注释改为 `Slot A: createLaunch` |
| — | `LiquidityPanel` 不可达 | **本文档原本漏报**。它挂在 `ProjectTerminal` 的 `full` 变体里，而唯一调用点传的是 `action-only`，导致整个加/撤流动性功能用户点不到。已移入实际渲染的分支，并删除不可达的 `full` 变体（259 行） |
| 8.1 (新) | `launch()` 必须等满窗口 | **保持**。和「窗口内一直可投、无硬顶」自洽。`/launch` 时长选择器旁加了警示，确认勾选也写明窗口不会因软顶提前结束 |
| 8.2 (新) | 交易税按 specified 侧路由 | **已闭环**。exact-input 仍在 `beforeSwap` 抽 input；exact-output 在 `afterSwap` 对 unspecified input 补齐 Delta（掩码 `0x20C8` → `0x20CC`）。买单无论怎么构造都把 0.7% ETH 送进国库，卖单都烧币。`test_buyTax_exactOutputSkimsEthNotTokens` / `test_sellTax_exactOutputBurnsTokensNotEth` |
| 8.3 (新) | `pogQuota` 只上调不下调 | **保持**。风控收紧不追溯。README 与 `registerPoG` natspec 已写明：调低 `maxPogAllocationLimit` 不回收已登记额度 |
| 8.4 (新) | `registerPoG` 不检查黑名单 | **已修**。与 `deposit` 对齐，被拉黑钱包无法注册或提升额度。`test_registerPoG_rejectsBlacklisted` |
| 8.5 (新) | 平台暂停覆盖不到 hook 与池子 | **接受，后经 D3 部分修订**。`pause()` 覆盖面维持不变，「已发射项目的交易、领取、退款不可被平台干预」仍然成立；但 D3 新增了一个**只停阶梯铸造、7 天自动失效、可按项目分域**的独立刹车，用于货架定价本身出缺陷时的事故响应。`INCIDENT_RESPONSE.md` 需同步这条新边界 |
| 8.6 (新) | `refundEnabled` 只写不读 | **保持代码，改注释**。明确为事件去重标记，权威状态是 `canRefund()` |
| 8.7 (新) | 货架套利窗口无量化保护 | **已钉**。`test_sweepIsProfitableOnceTheMarketHasRunAhead` 上界从 `2×` 收紧到 `1.5×`。`ExceedsTierRemaining` 错误注释改为指向 `maxMintable()` |
| 8.8 (新) | 开盘初期 TWAP 退化为纯 spot | **已闭环**。`span < TWAP_WINDOW`（含 `twap == 0`）时 `_safeReferencePrice = min(spot, p0)`，两步脉冲最多顶开货架 0。`test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump` |
| 8.9 (新) | hook 余尘无清扫路径 | **保持无清扫口**（与国库单向阀同一取舍），补量级断言：ETH 余尘 `< 0.001 ether`，代币余尘 `< 1e18` |
| 8.10 (新) | 顺风车每次固定 1 ETH | **改为按余额 10% 投放，1 ETH 下限**。`SPEND_BPS = 1000`。`test_piggyback_spendsTenPercentOnceThePotIsFull` |
| 8.11 (新) | 回购策展是 owner 单点 | **接受，靠治理**。部署脚本已强制 owner 是 Safe 且两步移交。`INCIDENT_RESPONSE.md` 写入策展政策：FIFO 挂牌、`removeLadderToken` 只用于敌对或损坏池 |
| 8.12 (新) | LP 撤出滑点建立在滞后价格上 | **容差用户可调，默认 1%**。`LiquidityPanel` 提供 0.5 / 1 / 2 / 5% 四档 |
| 8.13 (新) | 链上地址与 chainId 写死在源码 | **拆开**。`POOL_MANAGER` 保持硬编码（错的会静默 mis-CREATE2）；`POSITION_MANAGER` / `PERMIT2` / `STATE_VIEW` / `NEXT_PUBLIC_CHAIN_ID` 走环境变量，fallback 为 Base Sepolia |
| 8.14 (新) | 冷却期与额度窗口是同一旋钮 | **拆成两个独立参数**。`cooldownDuration` 管 per-(wallet, hook) 再存款冷却；`quotaWindowDuration` 管 PoG 额度窗口。`= 0` 时额度退化为终身预算，只影响第二个旋钮 |
| 8.15 (新) | PoG 命名不统一 | **统一为 Proof-of-Gas**。合约 natspec、README、前端一致 |
| 8.26 | PoG 命名不统一 | 并入 8.15，已关闭 |

### 8.26–8.31 —— 红队对抗审查（v5.0 后期）追加

以下六条来自一轮以攻击者视角进行的对抗性复查，PoC 全部落在 `test/ToshV5Attack.t.sol`。**没有发现任何盗取用户资金或突破 21M 硬顶的路径**；问题集中在经济设计、治理杠杆，以及文档所声称的与代码实际做的之间的偏差。

| 编号 | 条目 | 处置 |
|---|---|---|
| 8.26 (红队) | **「阶梯开盘即锁」是 1 wei 的掷硬币** | **已修**。natspec 称 Phase-2 开盘完全关闭，但 `shelfP0` 与 `ceiling` 是同一个 `(x * 10500) / 10000` 表达式分别作用于 `p0` 与 `min(spot, p0)`，闸门用严格 `>`，货架 0 正好坐在边界上——放不放行取决于 spot 经 `_toSqrtPriceX96` / `_sqrtPriceToEthPerToken` 往返截断后落在 `p0` 哪一侧，而那取决于**募资额**：扫 1–24 ETH，只有 10 ETH 那档是开着的，原测试恰好只跑了一个募资额。修法是 `launch()` 主动盖 `lastSwapBlock`，复用同区块锁把开盘区块整个关掉——对所有募资额确定成立，买家损失的只是一个区块，且不动定价代数。连带修正：`maxMintable()` 原先不看同区块锁，会报出下一笔调用必然拒绝的数量。`test_ladderOpensLockedAtLaunch_acrossRaiseSizes` / `test_probeA_shelfZeroInLaunchBlock` |
| 8.27 (红队) | **`setMaxPogAllocationLimit(0)` 锁死全站发射** | **已修**。该值快照进每个新 hook 的构造函数，而构造函数 `require(_perWalletCap > 0)`，所以归零会让 CREATE2 构造 revert、`createLaunch` 对**每一个** creator 以 `DeployFailed` 报废——出自一个文档写着「只影响新项目」的开关，且签名与事件里都看不出这一点。现加 `InvalidPogLimit` 拒绝零值，失败暴露在治理调用处而不是每个 creator 的交易里。前端同步拦截并把「0 = 冻结注册」的错误文案换掉。`test_probeK_zeroPogLimitBricksCreateLaunch` |
| 8.28 (红队) | **推荐返佣可用第二个钱包自我农场** | **已修（缓解）**。`_recordReferral` 原本只挡 `referrer == user`，而 natspec 声称这阻止了「任何人农自己的 10%」。一个地址的深度：换个自己的小号即可，且那个小号不需要额度、不需要出资、不需要任何历史——这不是推荐计划，是给知情者的一个 10% 暗折，由只有不知情者才会缴的孤儿佣金买单。现要求 `pogQuota[referrer] > 0`。**这挡不住铁了心的女巫**（推荐人本质就是个地址，链上做不到），它把判断挪到唯一能判断的地方：PoG 预言机。详见 §2.2.8。`test_probeJ_referralSelfFarmViaSecondWallet` |
| 8.29 (红队) | **TWAP 深度即 `TWAP_WINDOW`** | **已缓解（参数）**。见 §5.1 的 ⚠️ 8.29 与 8.30。`TWAP_WINDOW` 600 → 1800；`twapSqrtPriceX96()` 未满窗口返回 0，与 `_safeReferencePrice` 口径对齐。**无结构性解**——要更深必须上环形缓冲，见 §11 待决策 D4 |
| 8.30 (红队) | **国库「单向阀」管的是保管权，不是受益人** | **已缓解**。`ToshLadderTreasury` 声称「owner、hook、工厂谁都无法转走一个 wei」——这句话为真，但极易被读成关于受益人的声明。资金确实被销毁，但 owner 可以用 `removeLadderToken` 把挂牌列表收窄到一个代币，从而把全部买压指向自己持有的盘口，把国库当作价格支撑使用。`perToken` 原为 `spend / count`，窄名单会拿到**同样一张支票的浓缩**；现改为 `spend / BATCH_SIZE`，稳态（≥3 个挂牌）行为完全不变，只在被人为收窄的列表上生效。需要说清的是：该池深下真正的限流器是 `_buybackSqrtFloor`——储备再大，单腿也只能把价格推到 TWAP 下限就停止成交，除数是它背后的纵深防御。（8.33 把每次 poke 的腿数降到 1 之后，投放同样多的 ETH 需要三倍的 poke 次数，但每腿的额度与这条下限都没变，所以这里的结论不受影响。）natspec 与 admin 面板文案均已诚实化。**未加时间锁**，见 §11 待决策 D2。`test_probeL_ownerDirectsEntireReservoirAtOneMarket` |
| 8.31 (红队) | **同一代币可开无 hook 平行池** | **无链上解，改文档**。V4 只对指名自己的池子发言，`beforeInitialize` 只能挡绑定本 hook 的池。任何人都能给同一个 ERC-20 开无 hook 的 ETH/token 池，绕过 0.7% 税、不喂预言机、不供回购；代币是无 transfer hook 的普通 ERC-20，合约层无从阻止，也没有尝试阻止。**真正要记住的不是漏掉的税**，而是 `_safeReferencePrice` 是**单场地**的——它只读本池。流动性外迁会削薄反尖刺闸门所依据的那本盘口，从而降低撬动它的成本。创世仓位永久锁在本池，这才是本池保持最深的原因，也才是参考价有意义的原因。`test_probeH_hooklessParallelPool` |

**低危、已作为现状接受**（均已在代码注释中记录）：143 wei 以下的粉尘 swap 因取整免税（经济上不成立）；1 wei 可买 799,999 wei-token 的铸造取整边缘（不可放大）；砸盘会暂时冻结阶梯直到套利回补（`min(spot, TWAP)` 设计的既定代价）；186 wei-token 的创世残尘（与 8.9 新 同一取舍）。

**经受住攻击的防御**：国库回购的原子三明治（`_buybackSqrtFloor` 使国库总是在攻击者砸盘**之后**买入而非之前）；供应硬顶闭合且精确；hook 权限掩码 `0x20CC` 正确；`refund()` 与 `launch()` 互斥；CEI 与重入防护（OZ `nonReentrant` + V4 unlock 模式）稳固。

### 8.32–8.34 —— gas 成本复查追加

以下三条来自一轮以「用户实际付多少、会不会白付」为目标的复查。8.32 是本轮唯一的**正确性缺陷**，另两条是纯成本项。

| 编号 | 条目 | 处置 |
|---|---|---|
| 8.32 | **顺风车会把推过阈值的那笔交易搞挂** | **已修**。买入税在 `beforeSwap` 就 `take` 进国库，所以一笔交易能开始时未武装、到 `afterSwap` 时已武装——被收费跑回购的恰恰是把储备推过阈值的那一笔，而它按未武装的池子估的 gas。不是概率性的倒霉窗口，而是**每个周期确定性地都有一笔**。`try/catch` 不管用：子调用 OOG 后 63/64 规则只留给外层六十四分之一，走不完 `afterSwap` 加 V4 关帧，交易连同回购一起死。修法是 `PIGGYBACK_MIN_GAS` 余量门控加 `{gas: avail - PIGGYBACK_TAIL_RESERVE}` 硬上限——收尾的份额是**物理扣下的**，不是估出来的，所以一条腿再贵也只会被跳过。代价是活性,由无许可的 `pokeBuyback()` 兜住,并加了 `STATE-06` 轮询。`test_piggybackSkipsRatherThanKillingTheTrade` / `test_piggybackSparesTheTradeThatTipsIt` / `test_pokeBuyback_deploysWithoutASwap` |
| 8.33 | **一次 poke 三条腿，峰值 579k** | **已修**。见 §4.9：`LEGS_PER_POKE` 拆离 `BATCH_SIZE`，每次一条腿，分仓除数不变。峰值 578,809 → 362,884，每池到账金额不变。`test_gas_piggybackCostPerLeg` |
| 8.34 | **门控标定过高会静默注销整个搭车机制** | **已修**。`PIGGYBACK_MIN_GAS` 初值 260,000 时，钱包要加 22% buffer 回购才肯上车——超出常规 buffer，机制实际退化成只能靠 `pokeBuyback`。根因是 gas 相关控制流破坏 `eth_estimateGas`：模拟时上限充裕会走回购分支报 333k，真跑时到 poke 点只剩「上限减去已花的 147k」。改到 230,000 后降到 12%。这里的不对称是关键——**订低只是偶尔浪费一次注定失败的 poke，交易永远安全;订高则悄悄注销机制**，所以该往低取。`test_piggybackStillRidesAProperlyEstimatedSwap` 用结构性断言（`MIN_GAS ≤ TAIL_RESERVE + 实测一条腿 + 余量`）而非百分比,因为百分比在两种 gas 记账模式下不可比 |

**顺带发现的两个测试缺陷**（不影响合约）：一个确定性测试用 `vm.assume` 掩盖 fixture 攒不够 1 ETH——非 fuzz 测试里 assume 无法重采样，只会硬挂；一个 fuzz 反例 `3150e18 + 1` 切分后尾块只剩 1 wei，成本向下取整成 0 撞上防尘埃守卫,属于**合约正确、测试的分解策略在该输入上无定义**,已收窄定义域而非绕过守卫。

**CI 追加**：`forge test --isolate` 作为第二道门。普通模式让 setup 碰过的存储全程预热，后续调用都比链上便宜;两种记账在同一个测试上给出 15% 和 45% 两个数字。已有两个 bug 只有 isolate 能抓到。

---

本章第 8.1–8.15 系列已无未决项。红队追加的 8.26–8.31 中，8.29–8.31 保留了**需要产品决策的开放项**，见 §11。gas 复查追加的 8.32–8.34 均已闭环。

---

## 11. 决策记录（Decision Record）

以下四条不是缺陷，是**产品方已经拍板的取舍**。本节记录的是决定本身、理由、落地位置，以及**什么条件下应当重新审视**——最后一项尤其重要：一个没写下重审条件的决定，等于把当时的假设永久化了。

四条均于 v5.0 红队复查后一次性定稿。D1 与 D3 改变了代码，D2 与 D4 是明确的「维持现状」——**「维持现状」也是一个决定，不是没有决定**，所以同样立此存照。

---

### D1 · 参数固化：接受 24.9% 的早期放量

**决定：固化【2000× 跨度 / 4000 档 / 等量平均分配 / 8.4M 创世 + 12.6M 货架】，不再继续压早期放量。**

| 参数 | 定值 |
|---|---|
| `GENESIS_SUPPLY` | 8,400,000e18（Claim 4.62M + LP 3.78M） |
| `BONDING_MAX` | 12,600,000e18 |
| `TIER_COUNT` | 4000 |
| `TIER_SIZE` | 3,150e18（每档等量） |
| `TIER_STEP_E18` | 1,001,902,508,266,805,824 |
| `MAX_TIERS_PER_TX` | 32 |

**接受的代价，说清楚：** 2× 时释放 1,149,750 枚。对 `GENESIS_SUPPLY` 是 13.7%，对**可交易认领盘**是 24.9%，对释放后总流通盘是 19.9%（三个口径见 §3.1 与 §3.4）。最初提出的目标是流通盘 ~10%，**这个目标没有达成，且决定不再追**。

**理由：** 40/60 拆分把 36.5% 压到 13.7% 是同口径下的真实改进，剩下的差距只能靠加大跨度或再缩 Phase 2 来补，而两者都比它们修的问题更糟——等量档位下释放比例是 `log(R) / log(SPAN)`，跨度对早期的边际作用是对数级的（1000×→2000× 只把 2× 释放从 36.5% 挪到 34.9%，真正起作用的是切分），代价却是整条中后期曲线被拉平；再缩 Phase 2 则会削掉市场唯一能定价的那部分供应，把项目推回「创世盘决定一切」的老问题。

**落地：** `test_ratifiedParameterSet_isFrozen` @ `test/ToshV5.t.sol` 把六个字面量钉在一处，作为改动经济模型的**单一闸门**；`test_earlyReleaseSchedule_isSetByTheSupplySplit` 同时钉住三个口径的释放比例，任何一个口径变了都得重述另外两个。

**重审条件：** 若首批真实项目在 2× 附近出现持续的卖压塌陷（即 24.9% 事实上吃不下），或跨度/切分因其他原因需要改动时，一并重开此条。

---

### D2 · 国库策展：不加时间锁，依赖多签流程

**决定：`addLadderToken` / `removeLadderToken` 维持 owner 即时生效，不引入 timelock。**

**理由：** 8.30 的两处缓解（`perToken` 除以 `BATCH_SIZE`、`_buybackSqrtFloor` 按窗口限速）已经把「随时把储备抽干砸向单一盘口」降级为「按窗口限速的缓慢倾斜」，剩下的是**治理面而非代码面**的风险。timelock 在这里的收益并不对称：它拦不住一个铁了心的 owner（等 48 小时即可），却会在真正需要紧急摘牌时（比如某个已挂牌项目的池子出了问题、继续回购等于往坏池子里送钱）强制延迟 48 小时。既然 owner 终局是 Safe 多签，多签自身的提案—审批流程已经提供了「改动可见、需要多人同意」这一层，与 timelock 想买的是同一样东西。

**前提（已确认）：** Factory 与 LadderTreasury 的终局 owner 为 **Safe 多签，2/N 或更严格**。**这条决定完全建立在这个前提上**——多签的提案—审批流程就是本决定用来替代 timelock 的那一层保护，前提不成立则决定不成立。

**落地：** 无代码改动。`ToshLadderTreasury` 的 natspec 与 admin 面板 G4 文案已诚实标注「策展不是中立的，它是经济旋钮」。

**重审条件：** ①owner 结构若退化为单 EOA 或 1/N 多签，**必须立即补 timelock**，本决定自动失效；②国库储备规模显著超过单个已挂牌项目的池深时应重审——那时集中度的绝对影响会超过 sqrt 地板的限速能力；③所有权移交完成后，应在 `INCIDENT_RESPONSE.md` 记录实际的 N 与阈值，使前提可被审计而不是口头相传。

---

### D3 · 协议级熔断：新增有界的阶梯停售开关

**决定：新增 `haltLadderMinting` / `resumeLadderMinting`，这是唯一一个能触及已开盘项目的平台刹车。此条修订 §8.5 (新) 记录的「已发射项目完全不可被平台干预」承诺。**

**为什么开这个口子：** `pause()` 有意不停任何已开盘项目，这条边界是平台的核心承诺，但它留下了一个值得关门的缺口——**如果货架定价本身被发现有缺陷，每一个在跑的项目都会继续按那个缺陷卖出供应，而唯一的应对手段是好言相劝**。这不是理论风险：本轮红队就在定价闸门上找到了 8.26（开盘锁是掷硬币）。

**为什么它没有变成一个否决权：** 三条性质把新增的信任假设约束成有界的：

1. **只触及 `mintBondingCurve`，别无其他。** 池子 swap、散户 LP、`claimGenesis`、`claimReferralReward`、`refund` 全部不受影响。**停售能让买家损失一个机会，永远不能让任何人损失一笔余额**——没有任何用户资金会被它扣住。
2. **它会自己过期。** 每次停售携带一个不超过 `MAX_HALT_DURATION`（7 天）的截止时间。一个变坏的、被攻陷的、或者干脆消失了的 owner **无法永久锁死 Phase 2**，最坏情况是一个必须每周在链上公开续期一次的滚动停售。这是「破窗锤」与「杀死开关」的区别，也是新信任假设有界而非绝对的原因。
3. **它是可分域的。** `hook == address(0)` 停全部，任何其他地址只停那一个项目，单个出问题的市场不需要把全平台的 Phase 2 拖下水。

**为什么是独立开关而不是并进 `pause()`：** 合并会悄悄拓宽「paused」这个词对每一个读者和每一个既有测试的含义。两个刹车回答的是不同问题——`pause()` 阻止平台**生长**，这个阻止阶梯**售卖**。

**落地：** `ToshFactory.haltLadderMinting` / `resumeLadderMinting` / `ladderMintingHalted`；hook 侧 Guard 0 与 `LadderMintingHalted` 错误；`maxMintable()` 同步读取，保证 UI 与闸门口径一致；admin 面板新增对应模块。

**重审条件：** 若上线一年内从未使用，应重新评估它是否值得继续承担这份信任假设。反之若被使用超过一次，说明货架定价需要的是修复而不是刹车。

---

### D4 · TWAP 深度：维持 1800s 两检查点，不上环形缓冲

**决定：`TWAP_WINDOW` 保持 1800 秒，不改造成完整环形缓冲。**

**接受的代价，说清楚：** 预言机的操纵深度**就等于** `TWAP_WINDOW`。攻击者把价格顶住 30 分钟再用灰尘 swap 触发检查点滚动，均价即收敛到操纵价（§8.29，`test_probeB_twapReanchorSpeed` 钉住了这个行为）。1800s 相对原先 600s 把这份持仓成本翻了三倍，但它是**提价，不是变形**。

**理由：** 完整环形缓冲能把深度与单笔成本解耦，代价是一次不小的重写，且把 gas 从「每窗口一次冷 SSTORE」推回接近「每笔 swap 一次」——这笔成本由**每一个诚实交易者**承担，用来防一个必须先自掏腰包把价格顶住半小时、且顶完还要面对 105% 溢价才能铸造的攻击者。继续加大 `TWAP_WINDOW` 则是零工程量的线性提价，但会同步拖慢**真实**上涨的市场打开阶梯的速度，30 分钟已接近这个取舍的拐点。

**落地：** 无代码改动。`TWAP_WINDOW` 的 natspec 已明写「这个常数就是预言机的全部纵深，把它读作价格而不是保证」。

**重审条件：** 若出现一次真实的持价操纵（而非理论推演），或阶梯铸造的经济激励发生变化（例如 `SHELF_PREMIUM_BPS` 下调，使得操纵后铸造真正有利可图）——目前挡住攻击的主力是 105% 溢价而不是预言机，一旦那层保护变薄，这条必须重开。

---

## 附：本文档的取证边界

- 本文档 §8.26–8.31 与 §11 对应的那轮改动**已执行** `forge build` 与 `forge test`、前端 `npm run build` 与 `npm run lint`（均无错误）。§11 定稿（D1 参数固化 + D3 阶梯停售）后重跑为 250/250 通过；随后补入 `test_ladderHalt_cannotHoldAFailedGenesisHostage` 与 `test_ladderHalt_blocksNeitherLaunchNorPayouts` 两条「停售不得扣押退款/派息」用例，那一轮收在 252/252。此后又经历了有状态不变量套件、EIP-1167 克隆重构与 gas 优化三轮改动，**当前为 303/303 通过**（普通模式与 `--isolate` 各一遍，均为 CI 门禁）。此前章节的断言仍以静态阅读为主。
- **§8.12 的「pause 覆盖 `deposit`」是被本轮实测推翻的**：`deposit` 只有 `nonReentrant`，没有 `whenNotPaused`。该错误同时存在于 `INCIDENT_RESPONSE.md` §2 Step 2，两处均已修正。这提示本文其余「某函数受某修饰符保护」类断言若未标注测试名，都应视为待核实——**修饰符清单是最容易在重构中悄悄失真的一类文档**。
- **本条曾列出七个早已不存在的测试文件**（`ToshLaunchpadHook.t.sol`、`ToshFactory.t.sol`、`ToshFactoryCoverage.t.sol`、`ToshHookCoverage.t.sol`、`ToshPauseBlacklist.t.sol`、`ToshIntegration.t.sol`、`ToshFuzz.t.sol`）——测试套件早已合并为 `ToshV5*` 家族，而这份「未读清单」把读者指向了空气。当前实际存在的测试文件共 **10** 个：`ToshV5.t.sol`、`ToshV5Factory.t.sol`、`ToshV5Guards.t.sol`、`ToshV5Attack.t.sol`、`ToshV5Fuzz.t.sol`、`ToshV5Bytecode.t.sol`、`ToshV5Abi.t.sol`、`ToshV5Invariants.t.sol`、`ToshHookClone.t.sol`、`DeployMainnet.t.sol`。其中 `ToshV5Fuzz.t.sol` 与 `DeployMainnet.t.sol` 未通读全文，其余均已按测试名或关键段落核对。
  - 这份清单本身随后又漂了一次：`ToshV5Invariants.t.sol`（有状态不变量套件）与 `ToshHookClone.t.sol`（EIP-1167 克隆布局与参数往返）都是在它写下之后新增的，而它读起来像一份完备枚举。**同一段文字第二次因为同一个原因失真**，这比第一次更能说明问题——手写的文件清单没有任何机制在文件增删时提醒作者。
  - **然后它第三次失真了**（2026-09-03）：上面那句"当前实际存在的测试文件共 10 个"写下之后，`ToshV5ArbSys.t.sol`、`ToshV5Fork.t.sol`、`ToshV5LpMathVectors.t.sol` 新增，`ToshV5Bytecode.t.sol` 删除，实际是 **12** 个。**同一段文字，同一个原因，第三次。** 到这里就不该再改数字了——枚举本身才是缺陷。要当前名单请跑：

    ```bash
    ls test/*.t.sol
    ```

    并以 `docs/SECURITY_AUDIT.md` §4 的表格为准（那张表至少列出每个文件的用例数，改动时更难无声漂移）。**本文档此后不再维护测试文件的手写枚举。**
- 未阅读 `soat-frontend/src/app/admin/page.tsx`（51KB）、`UserDrawer.tsx`（33KB）、`useLaunchData.ts`、`pogQuota.ts`、`apiGuard.ts`、`api/` 下的服务端路由全文——PoG 签发链路与管理后台的细节可能有本文未覆盖的规则。
- `scripts/` 目录多数脚本（`extractAbis.js`、`pogSigner.ts`、`mineHookSalt.js`、`releaseCompare.js`、`checkEncoding.mjs`、`checkHookMinerTuple.mjs`）未阅读，只从其他文件的引用推断其作用。**"只从引用推断作用"这件事本身出过一次事故**：`extractBytecode.js` 曾在这份清单里，而从引用推断出的结论（"它维护的快照被前端依赖"）是错的，实际无人 import——见 §6.6 关键设计一节的旁注。本条曾列出一个并不存在的 `checkLpActions.ts`，已删除——它确实不在根 `scripts/` 下，而在 `soat-frontend/scripts/`（见 §上文 posm payload 一节）。根 `scripts/` 下新增的 `checkLpActionsAbi.mjs` 已通读，不在本清单内。
- **⚠️ 行号锚点已系统性失效。** 本文大量使用 `src/ToshLaunchpadHook.sol:857-877` 这类锚点。红队那轮往 Hook / Factory / Treasury 里插入了数十行说明性 natspec，所有位于插入点之后的锚点都已偏移。§1.2、§2.2.8、§5.1、§8.26–8.31 中被触及的锚点已改为**函数名**。此外，**指向 `test/*.t.sol` 的行号锚点已全部去掉行号、只留测试名**（共 30 处，均经机器校验：原行号所落入的函数与同一行标注的测试名不符）。指向 `src/` 的行号锚点仍未逐一校准。
  行号锚点在活跃代码库里本质上不可维护——它们在写下的那一刻就开始腐烂，而且腐烂时不会报错。**后续新增引用请一律锚定函数名或测试名，不要写行号**；已有的行号请当作「大致位置」而非事实。
  `scripts/checkDocAnchors.js` 现在把「文件不存在」和「行号超出文件末尾」这两类**机器可判定**的失效钉成硬失败（`node scripts/checkDocAnchors.js --strict`），并为每个锚点打印其落入的符号，供人工复核「落点是否还对得上」。
