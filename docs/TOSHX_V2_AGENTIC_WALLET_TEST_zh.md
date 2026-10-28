# ToshX v2：Agentic Wallet 真钱包实测步骤

目的：在正式上线前，用真实的 Binance Agentic Wallet 把 v2 的每个签名操作走一遍，确认 Binance 的预执行模拟、风控和钱包设置不会挡住用户。

合约层面已经确认的部分（不需要再测）：

- 2026-10-26 链上抽查最近 8000 个区块的全部 555 个 Agent ID 持有者：全部没有代码，没有 7702 委托；60 笔注册交易都由持有者本人直接签名。
- BSC 主网 fork 测试（`test/v2/ForkV2Bsc.t.sol`）用真实注册表、WBNB 和 PancakeSwap Infinity，以真实持有者 `beehaoyun`（`0x3DA4…9FE`）通过：能用 BNB 创世买入并开盘；同一地址打上 7702 委托标记后同样通过。

运行 fork 测试：

```powershell
$env:BSC_RPC="https://bsc-rpc.publicnode.com"
$env:AGENT_ID_HOLDER="0x3DA4edde05cA30529D545BB7108B88bdcc2de9FE"
forge test --match-path test/v2/ForkV2Bsc.t.sol -vv
```

---

## 1. 环境

**只能在 BSC 主网测**：Agentic Wallet 支持的链里没有 BSC 测试网，测试网的模拟注册表也认不出真实的 Agentic Wallet。

两种做法，推荐 A：

| 做法 | 说明 | 代价 |
|---|---|---|
| A. 主网预发布部署 | 用 `script/DeployV2.s.sol` 在主网单独部署一套，`PROD_OWNER_SAFE` 填一个测试用 Safe；前端预览环境指向这套地址 | 一次部署的 gas；项目不会出现在正式站 |
| B. 正式部署上建测试项目 | 正式部署完成后，用正式工厂建一个小额项目 | 测试项目会出现在正式目录里，需要事后说明 |

注意：在 56 链上，`DeployV2` 要求 `FEE_RECIPIENT` 等于平台手续费 Safe `0x02DE…B310`，A 方案也一样。

**测试项目参数**（取工厂允许的最小值）：

| 参数 | BNB 项目 | USDT 项目 |
|---|---|---|
| 硬顶 `hardCap` | 1 BNB | 500 USDT |
| 每个 Agent ID 额度 | 0.1 BNB（平台固定：每份 0.01 BNB，最多 10 份） | 5 USDT |
| 创世时长 | 3 小时 | 3 小时 |
| `developer`（Circuit NFT 持有者） | 测试人员自己的普通钱包，创世结束后可以立即开盘 | 同左 |

**参与的钱包**：

| 代号 | 类型 | 用途 |
|---|---|---|
| A | Agentic Wallet，已领取 Agent ID | 创世买入、卖出、转账、挂单撤单 |
| B | MetaMask 普通钱包，没有 Agent ID | 在网页上挂买单，接 A 的卖单 |
| C | 另一个普通钱包，先不登记 | 测试"未登记不能收币" |

**预算**：A 约 0.15 BNB（含 gas，第 2 步临时多付的 0.02 会退回），B 约 0.05 BNB，USDT 项目另需 A 约 10 USDT。

---

## 2. 开始前检查 A 的钱包设置

让 agent 运行 `baw wallet settings --json`，记录：

| 字段 | 需要的值 |
|---|---|
| `devMode.enabled` | `true`，`devMode.expiresAt` 在未来 |
| `devMode.dailyLimit` | 高于本次测试金额（最低档 1000 USDT 即可） |
| `devMode.balanceExceeded` | `false` |
| `abnormalTxnHandling` | 先保持默认 `AutoReject` 测一次，再改成 `NeedConfirmation` 测一次（见第 3 节第 1 步） |
| `tradeAllTokens` | 先保持默认 `false` 测一次，再改成 `true` |

---

## 3. 测试步骤

每一步都记录：preview 返回的 `simulationResult.simulationCode`、`risks`、`requireConfirmation`、错误码（如有）、`txHash`、链上结果。

**第 1 步：创世买入（BNB）**

1. 不连接钱包打开项目页，确认 Agent 模式默认展开，顶部提示"创世买入要由持有 Agent ID 的 Agentic Wallet 发起"。
2. 份数输入 9（0.09 BNB，额度还剩 1 份），勾选风险确认，复制指令发给 A 的 agent。
3. agent 执行 `contract-call preview`，记录模拟结果和风险提示；确认后 `execute`。
4. 回到页面填入 A 的地址，确认页面识别到交易并刷新。
5. 链上核对：A 的代币余额大于 0；`token.isReceiver(A) == true`。
6. 分别在 `abnormalTxnHandling = AutoReject` 和 `NeedConfirmation` 下各测一次，记录新代币是否被判为异常。

**预期**：模拟成功。如果被拦，记下错误码，常见的有：

| 错误码 | 含义 | 处理 |
|---|---|---|
| 351803 | 风控拦截 | 记录 `blockReason`；这是 Binance 侧的限制，需要联系 Binance |
| 351818 | 需要确认但钱包设成了自动拒绝 | 把异常交易处理改成"需要确认" |
| 351807 | 超过开发者模式每日额度 | 调高额度 |
| 351805 | 模拟失败 | 用 `cast call` 拿同样的 calldata 在节点上核对，区分合约回退和钱包侧模拟问题 |

**第 2 步：超额买入与找零**

再买 3 份，即 0.03 BNB（额度只剩 1 份 0.01）。预期：只扣剩余 0.01 额度对应的成本，多付的约 0.02 BNB 在同一笔交易里退回 A。核对 A 的 BNB 余额变化（扣除 gas 后约少 0.01）。之后再买一次，预期页面和模拟都提示额度已用完。

**第 3 步：USDT 项目创世买入**

同第 1 步，但指令会有两步：先 `approve` USDT 给 hook，再 `buyGenesis`。记录 approve 这一步的风险提示（授权给新合约通常会提示）。

**第 4 步：B 在网页上挂买单**

B 用 MetaMask 连接市场页，以不低于当前参与价的价格挂一张 0.01 BNB 的买单（页面会自动包装 WBNB、授权、挂单）。

**第 5 步：A 用 Agent 模式卖给 B 的买单**

1. 市场页选"卖出"，数量取 A 的一部分持仓，复制指令：先 `approve` 代币给买单簿，再 `fill`。
2. 记录 `tradeAllTokens = false` 时 approve 新代币是否被拒；改成 `true` 再测。
3. 链上核对：B 收到代币；A 收到 WBNB（成交额的 99%）。

**第 6 步：A 转账给 C**

1. C 未登记时，在页面"我的持仓"填 C 的地址，确认页面拦截并给出登记链接。
2. 让 agent 直接用 `contract-call` 调用 `transfer`（不经过页面拦截），记录 preview 的模拟结果。预期模拟失败，回退原因为 `ReceiverNotRegistered`，记下 Binance 怎么展示这个错误。
3. C 打开登记链接完成登记。
4. A 分别用两种方式转给 C，记录：
   - `baw wallet send`（Agentic Wallet 自带的发送）：C 不在地址簿时是否被拒；加入地址簿后，新代币能否发送。
   - `contract-call` 调用 `transfer`：是否同样受地址簿限制。

**第 7 步：A 挂单并撤单**

A 用 Agent 模式挂一张最低额买单，再撤单。核对托管资金全部退回。

**第 8 步：开盘**

创世结束后，`developer` 钱包在项目页点"开盘"。核对：池子建成、`tradingOpen == true`。

**第 9 步：开盘后**

1. 让 A 的 agent 运行 `baw market-order quote`，买入和卖出这个代币各报价一次，记录 Binance 的路由能否找到 Infinity 官方池（池子带 hook）。
2. 如果找不到，记录报错；这时开盘后的交易只能走 `contract-call` 或用户换普通钱包。
3. 开盘 30 分钟后，用 Agent 模式在货架买一档，核对铸币到账。

---

## 4. 结果怎么判断

| 结果 | 结论 |
|---|---|
| 第 1、3、5、6 步模拟和执行都成功 | 上线 |
| 只在默认设置下被拦，改设置后成功 | 上线；用户指南里把设置写成必做项（已写） |
| 改设置后仍被 351803 风控拦截 | 暂缓上线，联系 Binance |
| 第 9 步报价找不到官方池 | 可以上线；开盘后的交易引导用户走 Agent 模式指令或普通钱包，并联系 Binance 把官方池加入路由 |

---

## 5. 上线前参数核对：每个 Agent ID 的额度

开发者模式每日额度只有四档：1000、5000、10000、50000 USDT。每个 Agent ID 的首发额度超过用户所选档位时，用户一天之内买不满。

建议：

- USDT 工厂：主网部署值为每个 Agent ID 5–30,000 USDT。已决定把上限调到 **100 USDT**（与 BNB 市场 0.1 BNB 同一量级，远低于开发者模式最低一档），Safe 交易文件为仓库根目录的 `safe-v2-usdt-agentcap-100.json`，签名执行前链上仍是 30,000。
- BNB 工厂：额度固定为 0.1 BNB（`BNB_AGENTCAP_MIN` = `BNB_AGENTCAP_MAX` = 0.1 BNB，每份 0.01 BNB，最多 10 份），远低于开发者模式最低一档，不用再按 BNB 价格调整。

这两个值部署后可以由 Safe 经网关 `execute` 调用 `setAgentCapBounds` 调整，不需要重新部署；只影响之后上架的项目，已上架项目的额度在创建时就写死了。
