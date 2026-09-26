# 重新部署方案：创世手续费清扫（BSC 56）

> 状态：**待审**。本文只是方案，链上什么都还没做。
> 合约改动已在 `main`（`14cf35a`），内容见该提交说明与 `docs/AUDIT.md`
> 「Slither: the genesis fee sweep」一节。
>
> 部署的具体操作（预检、试跑、广播、中断续传、清理部署机）沿用
> `docs/MAINNET_REDEPLOY.md` §3–§7，本文不重复，只写**这次不一样的地方**。

## 1. 要部署什么，为什么只能重新部署

| 合约 | 为什么要新的 |
|---|---|
| 钩子实现 | `collectGenesisFees()` 是新代码；项目克隆永久指向工厂构造时部署的那份实现，没有代理、没有升级路径 |
| `ToshFactory` | `hookImplementation` 是 immutable，只能由新工厂的构造函数部署新实现 |
| `ToshLadderTreasury` | `setFactory` 只能调一次，旧金库已绑旧工厂；而且新金库的 `pokeBuyback` 才会先清扫 |

`script/DeployMainnet.s.sol` 一次广播就部署这三样（金库 → 工厂〔构造里部署实现〕→
`setFactory` → 把所有权转给 Safe），不依赖旧合约，可以原样再跑一遍。
上次实测 gas 约 20.9M，按 0.05 gwei 约 0.001 BNB，按 1 gwei 约 0.021 BNB。

## 2. 旧工厂上的 10 个项目

2026-09-26 从链上读到的状态：

| 状态 | 项目 | 还需要工厂吗 |
|---|---|---|
| 已发射（3 个） | TO、BEMCAT、QMT | 不需要。交易、领取、推荐奖励都直接调钩子 |
| 募资失败、可退款（7 个） | TEST2、SANBIN、PIRATE CAT、TAP、TOSHX、BEM、TEST | 不需要。`refund()` 直接调钩子；截止时间都已过去 |

**没有任何旧项目还在募资**，所以旧工厂的 `deposit` 和 `registerPoG` 以后不会再有人用。
这一点决定了前端的改动量：旧工厂只需要**只读地列出来**，存款、PoG 签名、发射、
管理面板全部只对新工厂。

如果部署前又出现了还在募资的旧项目，这个结论就不成立（前端现在已关闭发射入口，
不会再有新项目上旧工厂）。部署当天第 5 节第 1 步会再核对一次。

旧项目的已知代价，不变：
- 3 个已发射项目的创世手续费**永久锁死**（fork 实测当前约 18.26 BEM，其中 TO 约 18.20）。
- 旧金库继续收旧池子的买入税、继续回购旧代币，余额同样没有提取路径。

## 3. 前端要改的（部署前先合入，默认行为不变）

新增一个变量 `NEXT_PUBLIC_LEGACY_FACTORY_ADDRESSES`（逗号分隔的旧工厂地址）。
上线顺序是先合代码、变量不设，行为和现在完全一样；切换当天再设。

| 位置 | 改法 |
|---|---|
| `lib/contracts.ts` | 解析旧工厂列表，导出 `LISTED_FACTORIES = [FACTORY_ADDRESS, ...LEGACY]` |
| `directory/useDirectoryProjects.ts` | 目录从所有工厂的 `launches` 合并枚举（现在只扫一个，切换后旧项目会从目录消失） |
| `UserDrawer.tsx` | 「我的仓位」同样合并枚举；配额、冷却、黑名单只读新工厂 |
| `app/lib/getProject.ts` | `tokenToHook` 链上回退依次查所有工厂 |
| `api/projects/route.ts`（POST） | 接受任一已列出工厂的 `LaunchCreated` 收据 |
| `api/projects/launch-tx/route.ts` | `eth_getLogs` 的地址过滤带上所有工厂 |
| `ProjectTerminal/bondingState.tsx` | 阶梯暂停状态读**该项目自己的工厂**（`hook.factory()`），不能读全局那个——旧钩子的暂停开关在旧工厂上，读新工厂会误报「未暂停」 |
| `referrals/ReferralLedger.tsx` | 按项目读的部分跟随项目所属工厂 |

**不改的**：`GenesisPanel` 存款、`usePogFlow` / `sign-allocation` 签名、`/launch` 发射、
管理面板——它们都只该指向新工厂，而 `FACTORY_ADDRESS` 切换后正好就是新工厂。
签名路由里「`contractAddress` 必须等于 `FACTORY_ADDRESS`」这条保持不动，
它会自然拒绝给旧工厂签名。

测试：每处加「两个工厂各有项目」的用例；现有英文快照不应变化（变量不设时行为不变）。

## 4. 已定的决定（2026-09-26）

1. **PoG 签名地址：沿用** `0x57565feB…F877`。Vercel 里的私钥不动；签名摘要含工厂地址，
   旧工厂的签名在新工厂上用不了，不会串用。
2. **发射费：0.1 BNB**（链上值 `100000000000000000`，17 个 0；合约上限 0.5 BNB）。
   是原来 0.001 BNB 的 100 倍。前端显示的发射费是从链上 `launchFee()` 读的，不用改代码。
   `MAINNET_REDEPLOY.md` §5 第 3 步和「Decided 2026-09-21」一节写的还是 0.001 BNB，
   这次部署以本文为准，不要照抄那边的数字。
3. **监控：新旧两组都盯**。`monitoring/` 现在一次只盯一组工厂+金库，要改成能盯多组
   （旧金库还有余额、还在回购旧代币）。这项和第 3 节的前端改动一起做、一起测，
   在切换前合入。
4. **旧工厂的管理操作：只走 Safe**。管理面板只接新工厂；旧工厂以后要操作，
   直接在 Safe 界面调，不做界面。
5. **谁来广播**：部署私钥只在你的机器上。广播按 `MAINNET_REDEPLOY.md` §3 的方式由你
   输入私钥（`Read-Host`，不落盘、不进历史），我准备命令并逐步核对链上状态。

方案其余部分你还在考虑，改动待定。

## 5. 部署当天的顺序

每一步都有「完成的判据」，没达到就停。

| # | 步骤 | 完成的判据 |
|---|---|---|
| 0 | 第 3 节的前端代码已合入 `main`，CI 全绿，线上行为无变化 | 线上目录照常列出 10 个旧项目 |
| 1 | 再读一遍旧项目状态 | 10 个里没有还在募资的（全部已发射或可退款） |
| 2 | 预检 → 导出变量 → 试跑（`MAINNET_REDEPLOY.md` §3–§4） | 预检 exit 0；试跑清单里四个角色（Safe、PoG 签名、平台收款、部署者）都对 |
| 3 | 广播（断了就 `--resume`，不要重跑） | 拿到新 `FACTORY_ADDRESS`、`TREASURY_ADDRESS` |
| 4 | **部署者立刻 `pause()` 新工厂** | `paused() == true` |
| 5 | Safe 在新工厂、新金库上各 `acceptOwnership()` | 两边 `owner()` 都是 Safe，`pendingOwner()` 为 0 |
| 6 | Safe `setLaunchFee(100000000000000000)`（0.1 BNB，数清楚是 17 个 0） | `launchFee()` 读回 `100000000000000000` |
| 7 | `VerifyDeployment`（`EXPECTED_PAUSED=true`） | 全部不变量通过 |
| 8 | 核对新实现确实带清扫：`hookImplementation()` 的字节码里有 `collectGenesisFees` 选择器；新金库 `factory()` 是新工厂 | 两项读数一致 |
| 9 | Vercel 生产环境**一次性**改三项再手动重新部署一次：`NEXT_PUBLIC_FACTORY_ADDRESS`=新、`NEXT_PUBLIC_TREASURY_ADDRESS`=新、`NEXT_PUBLIC_LEGACY_FACTORY_ADDRESSES`=`0x20dE906A96FfB89BE6fd6267A0876A68017792F7` | `npm run check:quote` 通过；目录里 10 个旧项目都还在；`/launch` 仍显示暂停 |
| 10 | 监控加上新的一组，旧的一组保留；新一组的 `MONITOR_DEPLOY_BLOCK` 用这次广播的区块 | 一轮 watch 两组都跑到、0 告警 |
| 11 | **Safe `unpause()` 新工厂** | `paused() == false` |
| 12 | 删掉 Vercel 的 `NEXT_PUBLIC_LAUNCHES_PAUSED` 并重新部署 | 顶栏、首页重新出现「发射」入口 |
| 13 | 第一个新项目发射、TWAP 成熟后，Safe 在新金库 `addLadderToken`；有成交后手动调一次 `collectGenesisFees()` | 新金库收到 BEM、`0xdead` 收到代币、创世流动性不变 |

第 4–11 步之间新工厂是暂停的，前端也还关着发射入口，外人进不来。

## 6. 回退点

| 进行到 | 能否回退 | 代价 |
|---|---|---|
| 广播前 | 完全可以 | 无 |
| 广播后、Vercel 未切换 | 可以 | 新合约放着不用即可，损失部署 gas；线上一直是旧工厂 |
| Vercel 已切换、新工厂仍暂停 | 可以 | 把三个变量改回去再部署一次；新工厂上还没有任何项目 |
| 新工厂上出现第一个项目 | 不能 | 那个钩子是不可变的，存款人已经进来 |

## 7. 已知限制（写明，不在这次解决）

- **合约体积余量只剩 10 字节**（`HookDeployLib` 24,566 / 24,576）。以后钩子再加任何
  代码都要先腾地方，否则工厂部署不了。
- **Vault 余量的耦合**：买入税在买家付款前就从 Vault 转出，依赖 Vault 里有余量。
  主网 Vault 是所有 BEM 池共用的，不构成实际问题；只在单池、被抽干的测试环境里可见
  （`test_probeN_priceDrivenOntoTheRim` 注释里有记录）。
- 清扫只在 `pokeBuyback` 里自动发生，每次只扫这一轮要买的那个代币；游标会轮到每个
  代币，手续费不会丢，只是晚到。任何人也可以随时对单个项目直接调
  `collectGenesisFees()`。
