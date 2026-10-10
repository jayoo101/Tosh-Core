# 计价资产从 BEM 切换到 BNB：完整方案

> 状态：合约、测试、部署脚本、Safe 交接脚本、前端、PoG 签名服务、监控和报表脚本已在 `feat/bnb-quote` 完成，剩主网 fork 全流程演练和部署本身。部署步骤见 `DEPLOY_DAY_RUNBOOK_zh.md`。日期：2026-10-10。

## 已决定（2026-10-10）

- **零号 $ZERO 推迟**，等 BNB 版本上线后在新工厂发射。
- **路线 A：WBNB 作计价资产 + 原生 BNB 存款入口。**
- **先定参数，再动代码。**

## 参数（已采用）

按 2026-10-10 链上价格换算：PancakeSwap v3 BEM/WBNB 池 `0x28B1…BbC2`，**1 BEM ≈ 0.0278 BNB**（池内约 3,139 BEM / 50.1 WBNB）。

| 参数 | 现在（BEM） | 等值 BNB | 建议值 |
|---|---|---|---|
| 单地址上限 / PoG 额度上限 `maxPogAllocationLimit` | 46.4 BEM | 1.29 BNB | **1.3 BNB** |
| gas → 额度换算 | 1 ETH gas → 46.4 BEM | 1.29 BNB | **1 ETH gas → 1.3 BNB** |
| 额度门槛 | 0.025 ETH gas | — | **不变**（对应最低额度 0.0325 BNB） |
| 硬顶下限 `MIN_HARD_CAP` | 30 BEM | 0.83 BNB | **1 BNB** |
| 硬顶上限 `MAX_HARD_CAP` | 20,000 BEM | 557 BNB | **500 BNB** |
| 额度上限天花板 `MAX_POG_ALLOCATION_LIMIT` | 20,000 BEM | 557 BNB | **500 BNB** |
| 回购触发 `TRIGGER_STEP` / `PIGGYBACK_TRIGGER_STEP` | 10 BEM | 0.28 BNB | **0.3 BNB** |

`maxPogAllocationLimit` 是工厂上可调的参数，上线后 Safe 可以随时改；其余是常量，部署前必须定死。

---

## 0 · 结论先行

1. **现有合约无法切换。** BEM 是 `ToshFactory`、`ToshLaunchpadHook`、`ToshLadderTreasury`、`CircuitNFT` 的构造参数（immutable），没有任何 setter。这是故意的设计：防止平台在项目收钱之后改掉计价币。所以切换 = **部署一整套新合约**。
2. **不能简单回退。** 平台在 9 月从原生 BNB 改成 BEM（提交 `872697f`），之后又有 163 个提交（多签网关、Circuit 手续费、可选硬顶、Owner-only 发射等），直接 revert 不现实。
3. **推荐路线：以 WBNB 作为新的计价资产**，用户侧通过"原生 BNB 存款入口"无感使用 BNB。
4. **老项目不受影响。** $TO / $QMT / $BEMCAT 永久留在 BEM 工厂上，池子继续以 BEM 交易，网站继续展示（已有多工厂列表能力）。
5. **今晚 20:00 的零号来不及切换。** 整套改造需要 3–5 个工作日。已决定：零号推迟，在 BNB 版本上发射。

---

## 1 · 路线选择

| | A. WBNB 作计价资产（推荐） | B. 原生 BNB（`address(0)`） |
|---|---|---|
| 合约改动 | 小：ERC20 转账路径全部沿用，主要是小数位与常量 | 大：所有 `transferFrom` 改回 `msg.value` / `call{value}`，重新引入重入面 |
| 审计风险 | 低 | 高，等于重写资金路径 |
| 用户体验 | 加一个 `depositNative` 入口后，用户直接付 BNB；退款/领佣金收到 WBNB，前端一键解包 | 原生体验最好 |
| 代币地址排序 | 代币需排在 WBNB（`0xbb4C…095c`）之后，现有 CREATE2 研磨逻辑可用，期望约 3.7 次 | 原生币永远是 currency0，无需研磨 |
| 工期 | 3–5 天 | 2 周以上 |

---

## 2 · 合约改动清单（路线 A）

### 2.1 小数位：8 → 18

| 位置 | 现在 | 改为 |
|---|---|---|
| `ToshLaunchpadHook.QUOTE_DECIMALS` | 8（构造函数校验 `decimals()==8`） | 18 |
| `ToshFactory.QUOTE_UNIT` | `1e8` | `1e18` |
| `ToshFactory.MIN_HARD_CAP` | `30e8`（30 BEM） | `1e18`（1 BNB） |
| `ToshFactory.MAX_HARD_CAP` | `20_000e8` | `500e18`（500 BNB） |
| `ToshFactory.MAX_POG_ALLOCATION_LIMIT` | `20_000e8` | `500e18`（500 BNB） |
| `ToshFactory.maxPogAllocationLimit`（可调） | `46.4e8` | `1.3e18`（1.3 BNB） |
| `ToshLadderTreasury.TRIGGER_STEP` | `10e8` | `3e17`（0.3 BNB） |
| `ToshLaunchpadHook.PIGGYBACK_TRIGGER_STEP` | `10e8` | 与上一致 |

> 18 位小数下精度只会更好：`RaiseTooSmallForLadder`（`shelfP0 ≥ 526`）在 18 位时几乎不可能触发；价格与 tick 数量级整体平移 1e10，平台 9 月之前就是 18 位原生币，这套数学当时已验证过，但需要用新常量重跑全部测试。

### 2.2 原生 BNB 存款入口（新增）

在 `ToshFactory` 增加：

```solidity
function depositNative(address hook, address referrer) external payable nonReentrant;
```

逻辑：`WBNB.deposit{value: msg.value}()` → 走与 `deposit` 完全相同的检查（PoG 额度、冷却、单地址上限、硬顶、拉黑）→ `WBNB.transfer(hook, amount)`。不新增任何"把 BNB 发给用户"的路径，因此不引入新的重入面。

货架铸造同理可加 `buyNative`（Hook 上），或由前端在同一流程里先 wrap 再买。

### 2.3 需要重新部署的合约

1. `ToshLadderTreasury`（WBNB）
2. `ToshFactory`（WBNB；其构造函数会同时部署 Hook 实现、代币实现、`CircuitNFT`）
3. `ToshLaunchGateway`（`factory` 是 immutable，必须随工厂新部署）
4. 多签操作：新工厂 `transferOwnership(网关)` + `网关.execute(acceptOwnership)`，与上次相同的 Transaction Builder 流程
5. 回购金库的 `legacyFactory` 关系、`pogSigner`、费用接收地址（Safe）照旧配置

### 2.4 测试

- 全量单元 / 模糊 / 不变量测试改用 18 位 mock。
- 主网分叉测试改用**真实 WBNB**（`ToshV5Fork*.t.sol`）。
- 完整生命周期演练：创建 → 存款（含 `depositNative`）→ 开池 → 领取 → 交易 → 回购 → 退款。

---

## 3 · 前端与后端改动

| 模块 | 改动 |
|---|---|
| `lib/contracts.ts` | `QUOTE_DECIMALS` 由写死的 8 改为 18；`NEXT_PUBLIC_QUOTE_ASSET`=WBNB；显示符号用 `BNB` |
| 存款面板 | 默认走 `depositNative`，用户直接付 BNB，免授权 |
| 货架 / 池子交易 | 自动 wrap；Universal Router 用 `WRAP_ETH` 命令，卖出可 `UNWRAP_WETH` 直接收 BNB |
| 退款 / 推荐佣金 / Circuit 金库 | 收到的是 WBNB，加"一键解包为 BNB"按钮 |
| 多工厂列表 | 新工厂设为当前工厂，BEM 工厂进入"历史工厂"列表，老项目照常展示和交易 |
| PoG 签名服务 | 额度换算 1 ETH gas → 1.3 BNB，上限 1.3 BNB，门槛 0.025 ETH 不变。Upstash 里的参数按工厂地址分开存，新工厂直接用代码初始值，不需要 `rotateGasRate.mjs` |
| 首页文案 | 定位句里的计价资产名由 `QUOTE_SYMBOL` 填入，切到 WBNB 后自动变成 BNB |
| 守卫脚本 | `checkQuoteFormat`、`checkChainCopy`、`checkQuoteAsset` 等按 18 位与 WBNB 更新 |
| 监控 | `alerts.json`、`watch.mjs` 新工厂 / 金库 / 网关地址；`MONITOR_EXPECTED_GATEWAY` 更新 |

**PoG 额度需要重新激活**：额度记在工厂上，新工厂上所有人从 0 开始，首页「查询 / 激活打新额度」按钮切换环境变量后自动指向新工厂。

---

## 4 · 迁移步骤与时间

| 天 | 内容 |
|---|---|
| D1 | 合约改动（小数位、常量、`depositNative`）+ 全量测试 |
| D2 | 主网分叉演练（真实 WBNB、PancakeSwap Infinity）；部署脚本与 Safe JSON |
| D3 | 部署新金库、工厂、网关；Safe 签名移交；源码验证 |
| D3–D4 | 前端（存款 / 交易 / 解包 / 多工厂）、PoG 换算、监控 |
| D5 | 预发环境全流程走查 → 切换生产环境变量 → 公告 |

切换当天：新项目只能在新工厂发射；BEM 工厂不再新建项目（网关只指向新工厂即可，无需额外操作）。

---

## 5 · 业务影响（需要决策）

1. **零号 $ZERO**：今晚按原计划用 BEM 发射（推荐），还是推迟到 BNB 版本上线？宣发材料、推文、文章全部写的是 BEM。
2. **TapeOut 关系**：平台定位、Siman Labs 申请材料的核心论据都是「以 BEM 为唯一计价资产」，切换后需要重写，申请的「TapeOut 整合」部分会明显变弱。
3. **老项目**：$TO / $QMT / $BEMCAT 的池子和回购仍是 BEM，长期是两套资产并存。
4. **参数**：单地址上限、硬顶范围、gas→额度换算率、回购触发阈值，需要按 BNB 重新定价。

---

## 6 · 风险

- 新合约 = 新的部署风险面；必须完整走一遍分叉演练再上主网。
- WBNB 地址排序带来代币地址研磨（已有逻辑，256 次上限，失败概率可忽略）。
- 用户收到 WBNB 而不是 BNB 可能困惑，前端解包按钮与文案要到位。
- 两套工厂并存期间，监控、仪表盘、费用统计脚本都要同时覆盖。
