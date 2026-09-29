# 重新部署方案：新工厂（BSC 56）

> 状态：**待审**。本文只是方案，链上什么都还没做。
> 最初只为创世手续费清扫（`14cf35a`），之后又并入了下面第 1 节列的几项合约改动，
> 都在工作区里、随这次部署一起上。
>
> 部署的具体操作（预检、试跑、广播、中断续传、清理部署机）沿用
> `docs/MAINNET_REDEPLOY.md` §3–§7，本文不重复，只写**这次不一样的地方**。

## 1. 要部署什么，为什么只能重新部署

| 合约 | 为什么要新的 |
|---|---|
| 钩子实现 | 下表的钩子改动都是新代码；项目克隆永久指向工厂构造时部署的那份实现，没有代理、没有升级路径 |
| `ToshFactory` | `hookImplementation` 是 immutable，只能由新工厂的构造函数部署新实现；Circuit NFT 也在构造里部署 |
| `ToshLadderTreasury` | `setFactory` 只能调一次，旧金库已绑旧工厂；新参数（触发线、单次花费比例）是常量 |

这次一起上线的改动：

| 改动 | 在哪 | 说明 |
|---|---|---|
| 创世手续费可领取 | 钩子 `collectGenesisFees()` | 无权限，谁都能调。BEM 那一侧进该项目的 **Circuit 金库**（和货架收入同一个地方），代币那一侧销毁。**Circuit NFT 每次转手时自动先领一次**（失败不影响转手），所以卖家拿到转手前的手续费。金库的 `pokeBuyback` 不再清扫 |
| 只有平台能发射 | 工厂 `createLaunch` 改为 `onlyOwner` | 发射费删除（原定的 0.1 BNB 不再有意义）。Safe 发射用 `scripts/safeLaunchTx.mjs` |
| 开池由平台执行 | 工厂 `launch(hook)` | 钩子只接受工厂调 `launch`，所以开池权跟着工厂**当前** owner 走 |
| 冻结存款 | 工厂 `setDepositsPaused(hook, bool)` | 单个项目或 `address(0)` 全部。只挡新存款，退款、领取不受影响。监控 SWITCH-06 |
| 调低 / 收回 PoG 额度 | 工厂 `setPogQuota(users[], quota)` | 一次最多 200 个地址；同时作废已签未用的签名 |
| 超募部分归平台 | 钩子 | 开池时不进池子的余额转平台收款地址 |
| 无主推荐佣金归平台 | 钩子 | 没有推荐人的那份佣金转平台 |
| 回购参数 | 金库 | `TRIGGER_STEP` 10 BEM，`SPEND_BPS` 50% |
| **硬顶可选** | 工厂 `createLaunch` | `hardCap = 0` 表示不设硬顶，募资只在截止时间到才结束；见第 5 节 |

`script/DeployMainnet.s.sol` 一次广播就部署这三样（金库 → 工厂〔构造里部署实现和
Circuit NFT〕→ `setFactory` → 把所有权转给 Safe），不依赖旧合约，可以原样再跑一遍。
上次实测 gas 约 20.9M，按 0.05 gwei 约 0.001 BNB，按 1 gwei 约 0.021 BNB。

## 2. 旧工厂上的 10 个项目

旧工厂 `0x20dE906A96FfB89BE6fd6267A0876A68017792F7`，旧金库
`0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B`，owner `0x02DE4629129D104C63329D13A6Ca67E43db7B310`。

| 状态 | 项目 | 还需要工厂吗 |
|---|---|---|
| 已发射（3 个） | TO、BEMCAT、QMT | 不需要。交易、领取、推荐奖励都直接调钩子 |
| 募资失败、可退款（7 个） | TEST2、SANBIN、PIRATE CAT、TAP、TOSHX、BEM、TEST | 不需要。`refund()` 直接调钩子；截止时间都已过去 |

2026-09-29 读到的余额：

- **TOSHX 钩子里还有 3.5 BEM 没人退**（`0x1245ec46…6831CC9A`）。另外 3 个可退款项目已全部退完，3 个一分没募到。
- **TO 钩子里有约 23.19 BEM**，项目已发射，这笔大概率是还没领的推荐佣金。
- 3 个已发射项目的创世手续费**永久锁死**（旧钩子没有 `collectGenesisFees`，fork 实测约 18.26 BEM，其中 TO 约 18.20）。
- 旧金库继续收旧池子的买入税、继续回购旧代币，余额同样没有提取路径。

**没有任何旧项目还在募资**，所以旧工厂的 `deposit` 和 `registerPoG` 以后不会再有人用。
旧工厂只需要**只读地列出来**，存款、PoG 签名、发射、管理面板全部只对新工厂。

**旧工厂目前没有暂停**（`paused() == false`），而且旧版 `createLaunch` 是任何人交发射费就能调的。
切换后前端会把旧工厂上的项目也列出来，所以有人直接在旧工厂上发射的话，会出现在目录里。
建议旧 owner 在切换当天对旧工厂调一次 `pause()`（见第 7 节第 1 步）。

**已在主网 fork 上验证（2026-09-29）：旧工厂暂停不影响旧项目的退款和领取。**
- 旧钩子实现（`0x1a219137…1653`）的字节码里只调用工厂的 `ladderMintingHalted`、`ladderTreasury`、
  `poolManager`、`quoteAsset`、`vault`，都不受暂停限制；没有调用 `paused()`。
- fork 上用旧 owner 调 `pause()` 前后各跑一遍：TOSHX `refund()`、TO `claimGenesis()`、
  TO `claimReferralReward()` 暂停前后都成功、到账金额一致；阶梯的 `maxMintable()` 读数不变。
- 旧版 `createLaunch`（9 个参数、payable、任何人交发射费即可调）暂停后回退 `EnforcedPause()`，
  所以暂停确实能挡住旧工厂上的新发射。

## 3. 前端（已完成）

新增变量 `NEXT_PUBLIC_LEGACY_FACTORY_ADDRESSES`（逗号分隔的旧工厂地址，格式不对会直接报错，
不会悄悄漏掉）。不设时行为和现在完全一样；切换当天再设。

| 位置 | 改法 |
|---|---|
| `lib/contracts.ts` | 解析旧工厂列表，导出 `LISTED_FACTORIES = [FACTORY_ADDRESS, ...LEGACY]`、`isListedFactory` |
| `directory/useDirectoryProjects.ts` | 目录从所有工厂的 `launches` 合并枚举，每个项目带上 `factory`；「扫描被截断」按每个工厂分别判断 |
| `UserDrawer.tsx` | 「我的仓位」同样合并枚举；冷却读项目自己的工厂；配额、黑名单只读新工厂 |
| `app/lib/getProject.ts` | `tokenToHook` 先查新工厂，再依次查旧工厂 |
| `api/projects/route.ts`（POST） | 接受任一已列出工厂的 `LaunchCreated` 收据 |
| `api/projects/launch-tx/route.ts` | `eth_getLogs` 一次查所有工厂（旧工厂的 `LaunchCreated` 签名与新的一致，已核对字节码） |
| `ProjectTerminal/bondingState.tsx` | 阶梯暂停读**该项目自己的工厂**（`hook.factory()`）——旧钩子的暂停开关在旧工厂上，读新工厂会误报「未暂停」 |
| `referrals/ReferralLedger.tsx` | 按项目读的部分跟随项目所属工厂；「终身拉新数」对所有工厂求和 |

**不改的**：`GenesisPanel` 存款、`usePogFlow` / `sign-allocation` 签名、`/launch` 发射、
管理面板——它们都只该指向新工厂，而 `FACTORY_ADDRESS` 切换后正好就是新工厂。
签名路由里「`contractAddress` 必须等于 `FACTORY_ADDRESS`」保持不动，它会自然拒绝给旧工厂签名。

变量已登记到 `.env.production.example`、`checkSecretStore.mjs`（config 级），`checkPublicEnv` 通过。

## 4. 监控（已完成）

`monitoring/watch.mjs` 新增 `--legacy` 模式，`.github/workflows/watch.yml` 在设了
`MONITOR_LEGACY_FACTORY` 时，每轮先跑新的一组、再用独立的状态文件
（`.watch-state-legacy.json`，同样存在 `watcher-state` 分支）跑旧的一组。

旧的一组和新的一组的区别：
- 每条告警前缀 `[legacy <旧工厂地址>]`，所以两组的告警不会被合并成同一个 issue。
- 不查「任意地址」的钩子事件（新的一组已经覆盖所有钩子，查两遍只会重复告警）。
- 不报 WATCHER-07/08/09（链和告警目录是两组共用的，新的一组已经报）。
- 不跑 STATE-04/05/08（PoG 签名、keeper 余额、一人一次存款——都是管新存款的，旧工厂不再收存款）。

两组都改进的一点：钩子列表除了从 `LaunchCreated` 收集，还会遍历工厂的 `launches(i)`，
所以状态文件重置后、或者旧工厂的项目都在扫描窗口之前，STATE-01 也能盯到。
STATE-01（可退款但无人通知）改为看**钩子里还剩多少 BEM**，而不是累计存款——
累计存款退款后不会变，原来的写法会对已经退完的项目永远告警。

用旧的一组实测（主网、只读、`--dry`）：遍历到 10 个旧钩子，只有 TOSHX 一条 P1
（还有 3.5 BEM 未退），其余 6 个可退款项目记为「已退完 / 没募到」。

要新设的仓库变量：

| 变量 | 值 |
|---|---|
| `MONITOR_LEGACY_FACTORY` | `0x20dE906A96FfB89BE6fd6267A0876A68017792F7` |
| `MONITOR_LEGACY_TREASURY` | `0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B` |
| `MONITOR_LEGACY_EXPECTED_OWNER` | 旧工厂 owner（目前 `0x02DE4629129D104C63329D13A6Ca67E43db7B310`） |
| `MONITOR_LEGACY_DEPLOY_BLOCK` | 可不设；旧的一组首轮只回看 5000 个区块 |

`MONITOR_FACTORY` / `MONITOR_TREASURY` / `MONITOR_DEPLOY_BLOCK` 改成新的一组。
新的一组首轮会报一次 WATCHER-06（「盯的工厂换了」），这是预期的。

## 5. 硬顶可选（已完成）

- 合约：`createLaunch` 传 `hardCap = 0` 即不设硬顶，钩子里存成 `UNCAPPED = type(uint128).max`，
  存款判断 `total + amount > hardCap()` 永远不会触发，募资只在截止时间到才结束。
  钩子代码**没改**（它的部署库只剩 106 字节余量）。
- 不设硬顶时 `MIN_HARD_CAP` / `MAX_HARD_CAP` 不适用；单地址上限必须 > 0 且 ≤ `MAX_HARD_CAP`（20,000 BEM），
  用来防单位写错（`1e18` 写成 `1e8` 那种）。
- `hookInitcodeHash` / `verifyHookDeployment` 对 0 做同样的换算，所以用表单里的 0 预测出的钩子地址就是实际部署的地址。
- 测试：存储值、地址可预测、单地址上限边界、募资超过 20,000 BEM 仍能存；
  真实池子上募资 190,000 BEM（接近 BEM 全部供应量 191,739）仍能开池、能交易。
- 前端 `/launch` 的「上限」一栏加了「不设硬顶」勾选框，勾上后硬顶输入框禁用、条款里显示「硬顶 不设上限」。
  项目页和目录本来就不显示硬顶，不用改。
- Safe 发射脚本：`--hard-cap none`（或 `0`）。

## 6. 已定的决定

1. **PoG 签名地址：沿用** `0x57565feB…F877`。签名摘要含工厂地址，旧工厂的签名在新工厂上用不了。
2. **发射费：删除**。原定的 0.1 BNB 作废；`createLaunch` 只有 owner（Safe）能调。
3. **监控：新旧两组都盯**（第 4 节）。
4. **旧工厂的管理操作：只走 Safe / 旧 owner**，不做界面。
5. **谁来广播**：部署私钥只在你的机器上。广播按 `MAINNET_REDEPLOY.md` §3 的方式由你
   输入私钥（`Read-Host`，不落盘、不进历史），我准备命令并逐步核对链上状态。

## 7. 部署当天的顺序

每一步都有「完成的判据」，没达到就停。

| # | 步骤 | 完成的判据 |
|---|---|---|
| 0 | 第 3–5 节的代码已合入 `main`，CI 全绿，线上行为无变化 | 线上目录照常列出 10 个旧项目 |
| 1 | 再读一遍旧项目状态（`scripts/deployday-step1.ps1`）；旧 owner 对旧工厂 `pause()`（不挡退款和领取，第 2 节已验证） | 10 个里没有还在募资的；旧工厂 `paused() == true` |
| 2 | 预检 → 导出变量 → 试跑（`MAINNET_REDEPLOY.md` §3–§4） | 预检 exit 0；试跑清单里四个角色（Safe、PoG 签名、平台收款、部署者）都对 |
| 3 | 广播（断了就 `--resume`，不要重跑） | 拿到新 `FACTORY_ADDRESS`、`TREASURY_ADDRESS`、`CIRCUIT_NFT` |
| 4 | **部署者立刻 `pause()` 新工厂** | `paused() == true` |
| 5 | Safe 在新工厂、新金库上各 `acceptOwnership()` | 两边 `owner()` 都是 Safe，`pendingOwner()` 为 0 |
| 6 | `VerifyDeployment`（`EXPECTED_PAUSED=true`，`EXPECTED_OWNER`=Safe） | 全部不变量通过 |
| 7 | 核对新合约确实是这一版：实现字节码里有 `collectGenesisFees` 选择器；工厂有 `UNCAPPED()`、`launch(address)`、`setDepositsPaused`；金库 `TRIGGER_STEP() == 1000000000`、`SPEND_BPS() == 5000`、`factory()` 是新工厂 | 读数全部一致 |
| 8 | Vercel 生产环境**一次性**改完再手动重新部署一次：`NEXT_PUBLIC_FACTORY_ADDRESS`=新、`NEXT_PUBLIC_TREASURY_ADDRESS`=新、`NEXT_PUBLIC_LEGACY_FACTORY_ADDRESSES`=`0x20dE906A96FfB89BE6fd6267A0876A68017792F7`；`/apply` 用的 `APPLY_TELEGRAM_BOT_TOKEN`（secret）、`APPLY_TELEGRAM_CHAT_ID` 如未设一并设上 | `npm run check:quote` 通过；目录里 10 个旧项目都还在；`/launch` 仍显示暂停；`/apply` 提交一条测试申请能到群里 |
| 9 | 监控按第 4 节改变量 | 手动跑一轮 watch：两组都跑到；新的一组只有预期的 WATCHER-06；旧的一组只有 TOSHX 那条 STATE-01 |
| 10 | **Safe `unpause()` 新工厂** | `paused() == false` |
| 11 | 删掉 Vercel 的 `NEXT_PUBLIC_LAUNCHES_PAUSED` 并重新部署 | 顶栏、首页重新出现「发射」入口 |
| 12 | 第一个新项目：Safe 用 `safeLaunchTx.mjs create` 发射（要不设硬顶就 `--hard-cap none`）；募资结束后 `safeLaunchTx.mjs launch` 开池 | 钩子 `hardCap()` 与表单一致；开池后 `launched() == true` |
| 13 | TWAP 成熟后 Safe 在新金库 `addLadderToken`；有成交后手动调一次 `collectGenesisFees()` | 该项目的 Circuit 金库收到 BEM、`0xdead` 收到代币、创世流动性不变 |

第 4–10 步之间新工厂是暂停的，前端也还关着发射入口，外人进不来。

## 8. 回退点

| 进行到 | 能否回退 | 代价 |
|---|---|---|
| 广播前 | 完全可以 | 无（旧工厂若已暂停，旧 owner `unpause()` 即可） |
| 广播后、Vercel 未切换 | 可以 | 新合约放着不用即可，损失部署 gas；线上一直是旧工厂 |
| Vercel 已切换、新工厂仍暂停 | 可以 | 把三个变量改回去再部署一次；新工厂上还没有任何项目 |
| 新工厂上出现第一个项目 | 不能 | 那个钩子是不可变的，存款人已经进来 |

## 9. 已知限制（写明，不在这次解决）

- **钩子部署库余量只剩 106 字节**（`HookDeployLib` 24,470 / 24,576）。以后钩子再加代码都要先腾地方，
  否则工厂部署不了。工厂还有约 11.7 KB 余量。
- **创世手续费不会自己到账**：只在 Circuit NFT 转手时、或有人手动调 `collectGenesisFees()` 时领取。
  不领也不会丢，只是一直留在池子里。
- **不设硬顶的项目募资总额没有上限**：只受时间窗口、单地址上限和各钱包的 PoG 额度约束。
  池子按募资额比例建，190,000 BEM 已测过能开池；是否给某个项目不设硬顶，是审核时的决定。
- **Vault 余量的耦合**：买入税在买家付款前就从 Vault 转出，依赖 Vault 里有余量。
  主网 Vault 是所有 BEM 池共用的，不构成实际问题；只在单池、被抽干的测试环境里可见
  （`test_probeN_priceDrivenOntoTheRim` 注释里有记录）。
- `/launch` 的英文快照测试（`launch.golden.test.tsx`）已按「仅 owner、无发射费」的新页面重写：
  覆盖非 owner、owner 是 Safe、工厂暂停、硬顶越界、「不设硬顶」开关及其单地址上限、各个预检回滚。
