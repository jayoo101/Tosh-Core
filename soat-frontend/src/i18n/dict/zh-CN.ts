import type { PartialDictionary } from '../types'

/**
 * 简体中文。
 *
 * ── 这份翻译遵守的约定 ───────────────────────────────────────────────────────
 *
 *   1. 第二人称用「你」，不用「您」。英文原文的语气是短促直接的
 *      ("Take back the full amount, no penalty.")，整站统一，不混用。
 *
 *   2. 协议术语保留英文:GENESIS、PoG、ladder、shelf。它们是合约、文档和其他
 *      场所使用的同一批词，译成中文会让读者无法把屏幕上看到的和别处对应起来。
 *      首次出现可在括号里补一句解释。
 *
 *   3. 代号(BEM、QMT 等)永不进字符串，由 `fill()` 插值。
 *
 *   4. 数字与半角内容前后留一个空格:「7 天」「100% 退款」。
 *
 *   5. 「此钱包」而非「该钱包」或「这个钱包」，两处 reason 保持一致 —— 同一个
 *      面板上两句话用两个说法，读者会以为在说两件事。
 */
export const ZH_CN: PartialDictionary = {
  tx: {
    // `{action}` 是名词短语(见 `refund.txAction`)，所以「正在确认」后面不留空格。
    signing:    '等待签名 —— {action}',
    confirming: '已提交 · 正在确认{action}',
    confirmed:  '已确认 —— {action}',
  },

  gate: {
    connect:       '连接钱包',
    connecting:    '正在连接…',
    connectReason: '当前会话还没有连接钱包。',

    // `{chain}` 是链的官方英文名(BNB Smart Chain Testnet)，不译:用户要在钱包
    // 的网络列表里按这个名字去找，译成中文反而对不上。
    switchTo:  '切换到 {chain}',
    switching: '正在切换…',

    switchReasonUnknownChain:
      '此钱包没有报告所在的链。Tosh 在链 {target} 上结算，'
      + '每一笔写入都锁定在这条链上，从其他任何链发起都会被拒绝。',
    switchReasonWrongChain:
      '此钱包当前在链 {current} 上。Tosh 在链 {target} 上结算，'
      + '每一笔写入都锁定在这条链上，从这里发起会被拒绝。',

    // 按钮上的字，和上面 `tx` 里的通知文案是两回事:通知会活得比面板久，所以要
    // 带上动作名；按钮就长在那个面板里，不用重复说一遍。
    signing:    '等待签名…',
    confirming: '正在确认…',
  },

  nav: {
    // 和 `gate.connect` 是两条不同的字符串，理由见英文注释:顶栏在 390px 手机上要
    // 掉一个词。中文四个字两种情况都放得下，但这一对保留，让两种语言走同一条代码路径。
    connect:      '连接钱包',
    connectShort: '连接',
    connecting:   '连接中…',
  },

  wallet: {
    title: '连接钱包',
    close: '关闭',

    binanceDetected: '已在此浏览器中检测到',
    binanceOpenApp:  '在币安 App 中打开此页面',
    binanceScan:     '用币安 App 扫码连接',
    binanceInstall:  '下载币安 App',

    detected:          '已检测到',
    browserWallet:     '浏览器钱包',
    browserWalletHint: 'MetaMask、Rabby、OKX 等插件钱包',
    walletConnectHint: '用任意手机钱包扫码连接',

    footer: 'Tosh 在 {chain} 上结算。钱包连接后如果在其他网络，会请求切换。',
  },

  deposit: {
    title:    '存入 {quote}',
    subtitle: '存进这个项目的创世窗口。募资在倒计时结束前一直开放。',
    cta:      '存入 {quote}',
    txAction: '存款',

    amountLabel:       '存入金额 · {quote}',
    amountPlaceholder: '例如 0.05',

    errNotANumber:  '不是数字',
    errOverWindow:  '超过你本窗口的剩余额度',
    errOverCap:     '超过本项目的单钱包上限',
    errOverBalance: '超过你的余额',

    // ⚠ 这三句的主语不同，不能混用。「本项目每个钱包允许 X」说的是项目，对任何人都成立；
    //   「你还剩 X」说的是读者本人，绝不能对一个正在被面板拒绝的钱包说 —— 它曾经就印在
    //   一个因为同样原因而被禁用的输入框底下。
    hintCapOnly:     '本项目每个钱包允许 {cap} {quote}',
    hintCapAndYours: '本项目每个钱包允许 {cap} {quote} · 你还剩 {left} {quote}',
    hintOneAndDone:  '每个钱包只能存一次 · 你已投入 {committed} {quote}，本轮不会再向你收取',

    balanceReadout: '{quote} 余额',
    cooldownLabel: '冷却',
    cooldownClear: '已清零',
    referredBy:    '推荐人',
    referredHint:  '首次存款时全站绑定 · 其中 10% 记给对方',

    banPermanentStamp: '永久 · 无到期',
    banLapsedStamp:    '已失效',
    banLiftsInStamp:   '{d} 后解除',

    bannerWindowClosed: '→ 窗口已关闭 · 不再接受存款',

    bannerBanned: '→ 钱包已被拉黑 · {stamp}',
    // 强调落在「存款」，和英文的 *deposit* 对应。
    banBody: '封禁期间，工厂会拒绝这个地址的每一笔 *存款*，不论它持有多少额度 —— '
           + '所以这里的 0 是封禁，不是额度用光了。',
    banExpires: '封禁会在 *{when}* 自动到期，之后额度可以照常使用，不需要重置任何东西。',
    banPermanent: '只有协议管理员能解除永久封禁。',

    bannerScanning:   '→ 正在读取 GAS 历史',
    bannerQualifies:  '→ GAS 历史已达标',
    bannerBelowFloor: '→ 低于 GAS 门槛',
    bannerNoPog:      '→ 没有 POG 认证记录',

    bodyScanning:  '已连接 —— 正在查询这个地址在 {chains} 上的累计 gas。这一步不需要钱包签名。',
    bodyQualifies: '符合存款额度条件。激活一次（签名 + 链上登记）之后，存款就能正常使用，'
                 + '不用再单独点一次 gas 扫描。',
    // Historical gas figure: ETH here is the PoG denomination, not the settlement coin.
    bodyBelowFloor: '历史 gas 为 {gas} ETH，门槛是 {floor} ETH。打开明细可以看各链的数字。',
    bodyNoPog: '此钱包从未登记 Proof-of-Gas，因此没有可用额度。连接钱包后会自动开始 gas 查询。',

    windowClosedLabel:  '募资已关闭',
    windowClosedReason: '创世窗口已经关闭，不再接受任何存款。',

    bannedLabel:  '钱包已被封禁',
    bannedReason: '封禁期间，来自这个地址的存款会被拒绝 · {stamp}。',

    // 同一个事实的六张面孔。⚠ 查询失败值得再点一次，gas 低于门槛不值得 —— 对后者说
    //    「再试一次」，正是当初把共享扫描额度耗光的那个重试循环。
    pogScanningLabel:    '正在读取 gas 历史…',
    pogRegisteringLabel: '正在激活额度…',
    pogActivateLabel:    '激活存款额度',
    pogRetryLabel:       '重试 gas 检查',
    pogBelowFloorLabel:  '低于 gas 门槛',
    pogCheckLabel:       '检查 gas 历史',

    pogScanningReason:    '正在读取你在所有支持链上的累计 gas。这一步不需要签名。',
    pogRegisteringReason: '正在把存款额度写到链上。',
    pogActivateReason:    'gas 历史符合条件。点一下签名一次把额度登记上链，登记确认后存款即解锁。',
    pogRetryReason:       'gas 查询失败了。点一下可以重试。',
    // Historical gas figure: ETH here is the PoG denomination, not the settlement coin.
    pogBelowFloorReason:  '此钱包的历史 gas 低于 {floor} ETH 的门槛，因此无法为它核定存款额度。',
    pogCheckReason:       'Proof-of-Gas 按你的累计 gas 支出来核定存款额度。点一下读取即可 —— '
                        + '只发一个请求，不签名也不花 gas。',

    // ⚠ 同一个倒计时承载着两个不同的事实。冷却在创世窗口之前结束时，它是一段等待，
    //   把剩余时间说出来能告诉读者该怎么做。一旦它在截止之后才结束，读者做什么都来不及了，
    //   此时再放一个倒计时等于邀请对方回来 —— 而这恰恰是唯一行不通的事。
    cooldownLabelWaiting: '冷却中 · {left}',
    cooldownReasonWaiting: '此钱包对这个项目的存款还要冷却 {left}。',
    alreadyDepositedLabel:  '你已经存过了',
    alreadyDepositedReason: '这个项目每个钱包只收一次存款，你的已经到账 · 已投入 {committed} {quote}。'
                          + '冷却期比创世窗口还长，所以没有第二次存款可等。',

    amountInvalidLabel:  '检查一下金额',
    amountInvalidReason: '这个输入没法作为 {quote} 金额发送出去。',
    amountZeroLabel:     '输入金额',
    amountZeroReason:    '请输入要存入的 {quote} 金额。',

    quotaPendingLabel:  '正在读取你的额度…',
    quotaPendingReason: '正在等工厂返回此钱包的认证记录和存款窗口。',

    quotaExceededLabel:  '超出你的额度',
    quotaExceededReason: '超过了此钱包在当前窗口还能存入的金额 · 还剩 {left} {quote}。',

    walletCapLabel:  '超出单钱包上限 · 还剩 {left} {quote}',
    walletCapReason: '超过了本项目允许单个钱包持有的上限 · 你还剩 {left} {quote}。',

    notEnoughLabel:  '{quote} 不足',
    notEnoughReason: '此钱包没有这么多 {quote}。',

    approvingLabel: '正在授权…',
    approveLabel:   '授权 {amount} {quote}',
    approveReason:  '{quote} 是被划走的，不是你发过去的，所以工厂需要你先为这个确切金额授权才能扣款。'
                  + '这次授权只覆盖本笔存款 —— 改了金额就要重新授权一次。',
  },

  ledger: {
    // `[H-01]` 是和文档共用的编号，不动。
    heading: '// [H-01] 额度台账',

    quotaPerWindow: 'POG 额度 · 每窗口',
    spentThisWindow: '本窗口已用',
    remaining: '剩余',
    projected: '本次预计',

    statusConsumed:   '已用 {pct}%',
    // ⚠ 这三句绝不能写成「暂时无法显示」之类的中性话。英文注释记了原因:这三种情况
    //   下所有数字都是破折号，而页脚曾经照旧打印「在你的额度内」—— 一个永久不合格的
    //   钱包被告知只差输入一个数字。「读不出来」和「你没问题」在任何语言里都不能合并。
    statusCooldown:   '窗口读不出',
    statusBanned:     '已被拉黑',
    statusUnattested: '无认证记录',

    within:   '→ 在你的额度内',
    over:     '→ 超出本窗口额度',
    staleCooldown:   '→ 冷却期结束前读不出来',
    staleBanned:     '→ 这由封禁决定 · 拦住你的不是额度',
    staleUnattested: '→ 没有登记额度 · 目前没有可衡量的上限',
  },

  awaitingLaunch: {
    title:    '开池上线',
    subtitle: '开池会为 Infinity 池注入初始流动性，把创世流动性就地锁定，并启动 shelf ladder。此操作不可撤销。',

    raised:          '已募集',
    status:          '状态',
    statusValue:     '时间已到 · 可开池',
    windowRemaining: '窗口剩余',

    creatorBody: '{symbol} 是你创建的。触发上线会把募集到的 {quote} 与创世 LP 额度配对并启动 ladder。'
               + '交易一确认，存款人就能按比例领取自己的份额。',
    // `launch()` 是合约函数名，保留原样。
    creatorDeadline: '还剩 {countdown}。过了这个点，launch() 将永久失效，每个存款人都会取回 100% 的 {quote}。',
    cta:      '触发上线',
    txAction: '开池',
    txConfirmed: '池子已开 —— ladder 已上线',

    waitingTitle: '等待项目方操作',
    waitingBody:  '创世窗口已经关闭。如果 {countdown} 内池子仍未开启，退款终端会自动解锁，'
                + '全额退回你存入的 100%。你的 {quote} 没有风险。',

    expiredLabel:  '上线窗口已关闭',
    expiredReason: '开启交易的窗口已经关闭，这个项目现在唯一还能做的事就是退款。',
  },

  claim: {
    title:    '创世额度 · {symbol}',
    subtitle: '你在创世供应量中的份额，按你存入的金额等比分配。每个钱包只能领取一次。',

    yourDeposit: '你的创世存入金额',
    cta:         '领取 {symbol}',
    // 名词短语，理由同 `refund.txAction`:要套进「正在确认……」。
    txAction:    '领取 {symbol}',

    depositPendingLabel:  '正在读取你存入的金额…',
    depositPendingReason: '正在获取此钱包的创世存入金额 —— 额度就是按它等比算出来的。',

    claimedUnknownLabel:  '正在核对领取状态…',
    claimedUnknownReason: '正在读取此钱包是否已经领取过。每个钱包只能领一次，'
                        + '所以按钮会等这个答案，而不是让你发一笔注定失败的交易。',
  },

  ineligible: {
    title:    '此钱包无法存入',
    subtitle: 'Proof-of-Gas 按链上已经花掉的 gas 来决定每个钱包的存款额度。'
            + '这个地址花掉的还不够，因此没有额度。',

    banner: '→ 低于 GAS 门槛',
    thisWallet: '此钱包',
    floor:      '门槛',
    shortBy:    '相差',

    // ⚠ 这句话的任务是让读者别再试一次 —— 英文那边的注释记了一次事故:上一版界面
    //   摆着一个禁用的表单，暗示只差一个数字，读者反复重试把共享的扫描额度耗光，
    //   整个募资入口宕了 26 分钟。所以「这不是等待」必须说得毫不含糊，绝不能翻成
    //   「暂时不可用」「请稍后再试」之类。
    //
    // 强调落在「已经花掉的」，位置和英文不同 —— 英文的 *already spent* 在从句末尾，
    // 中文要挪到名词前面。这正是星号约定存在的原因。
    notAWait: '这不是排队，也不是冷却期 —— 这里没有什么可等的。'
            + '门槛比的是这个地址 *已经花掉的* gas，横跨 {chains}，'
            + '所以它只会随着这段历史增长而变化。',

    whatWouldWork: '// 什么做法有用',
    switchWallet:  '换一个你真正在用的地址 —— 有真实交易记录的主钱包通常自己就能过线。'
                 + '切换钱包会自动重新读取历史，这里没有需要你按的东西。',
    fundingWontHelp: '往一个新地址里转 {symbol} 并不能让它变得合格。额度来自花掉的 gas，'
                   + '这正是这套机制的用意。',

    breakdown: '查看各链明细',
  },

  refund: {
    title: '申领退款',

    // 两种失败都到这个面板，措辞必须说清到底是哪一种:
    // 规模不足是募资一结束就可退，而窗口过期是等了 7 天才可退。把后者当成前者
    // 说，会对一个还没超时、而且多半永远不会超时的项目方做出错误指控。
    reasonTooSmall:
      '本轮募资结束时规模太小，无法开池，因此直接关闭而没有上线。'
      + '你可以全额取回，不扣任何费用。',
    reasonLapsed:
      '7 天的开盘窗口已过期，项目方始终没有上线。'
      + '你可以全额取回，不扣任何费用。',

    yourDeposit: '你存入的金额',
    cta:         '申领 100% 退款',

    // 名词，不是动词短语。英文那边原本写的是动词("claim your refund"),
    // 拼出来是 "Submitted · confirming claim your refund" —— 只有英文能容忍
    // 动词短语占名词位置。中文套进「正在确认……」必须是名词。
    txAction:    '退款',
    txConfirmed: '退款已到账 —— 100% 全额返还',

    // 「读取中」和「没有」是两回事，绝不能合并。在这个页面上把前者说成后者，
    // 等于告诉一个正来取回资金的人「这里没你的钱」。
    pendingLabel:  '正在读取你存入的金额…',
    pendingReason: '正在获取此钱包在本项目中的余额。数据一到，按钮即可点击。',

    noneLabel:  '没有可退款项',
    noneReason: '此钱包在本项目中没有存入资金，因此没有可退的款项。',
  },

  success: {
    dialogLabel: '存款已确认',
    close:       '关闭',

    // `$` 是代号前面的符号，不是货币符号，必须保留 —— 全站都这么写 $TO、$QMT。
    title:  '你已进入 ${symbol}',
    staked: '已在本轮 GENESIS 中质押 {amount} {quote}',

    // 英文把因果放在一个冒号两边，中文把条件前置更自然:先说「只有……才」，
    // 再说「你现在满足了」。两个 `{pct}` 是同一个比例，`fill()` 会一起替换。
    body: '你的推荐链接刚刚变得更值钱了：{pct}% 的项目佣金只会绑定到'
        + '已经在这里存过款的推荐人身上，而你现在就是。把它分享出去，'
        + '每一笔通过它在 {symbol} 上完成的 GENESIS 存款，你都能拿到 {pct}%；'
        + '另外，凡是第一次点击 Tosh 链接来自你的钱包，你终身可拿 {lifetime}%。',

    linkBoxLabel: '你的推荐链接',
    copy:         '复制',

    // 方括号标的是链接。英文把它放在句中的介词短语里，中文改成句首的「要……请到」
    // 结构更顺，锚点也跟着移到前面 —— 这正是位置交给译者决定的理由。
    footer: '佣金随存款到账累计，项目上线时解锁。你可以在本页下方的推荐台申领，'
          + '也可以到[你的推荐台账]里一次结清所有项目。佣金永不过期。',
  },

  site: {
    // 中文「目录」本身够短，窄屏不需要再缩；两个键仍分开，便于日后改全称。
    navDirectory:     '目录',
    navDirectoryFull: '智能体目录',
    navLaunch:        '发射',
    navReferrals:     '推荐',
    footerSecurity:   '安全',
  },

  directory: {
    title: '智能体目录',
    lede:  'Tosh Protocol 上的每一个智能体代币 —— 从开放中的募资窗口到 shelf-ladder 交易，全部在 {chain} 上结算。',

    searchPlaceholder: '搜索…',
    searchLabel:       '按名称、代号或地址搜索项目',

    phaseHeading:        '阶段',
    phaseAll:            '全部项目',
    phaseAllBlurb:       '协议上的所有智能体',
    phaseLive:           '募资中',
    phaseLiveBlurb:      'Proof-of-Gas {quote} 存款开放中',
    // 与英文同样的约束:不能说「即将部署」—— launch() 只有创建者能调用。
    phaseLaunching:      '待上线',
    phaseLaunchingBlurb: '窗口已关闭 · 等待创建者',
    phaseCompleted:      '交易中',
    phaseCompletedBlurb: '已在 4,000 档 shelf ladder 上交易',
    // 不能说「窗口已过期」:募资不足的项目在 GENESIS 结束时就归档，窗口还没用完。
    phaseArchived:       '已归档',
    phaseArchivedBlurb:  '退款已开放 · 可全额取回存款',

    // 中文没有单复数，两个键同文。
    factoryCountOne:  '工厂合约上共 {n} 个项目 · {chain}',
    factoryCountMany: '工厂合约上共 {n} 个项目 · {chain}',

    // 前面紧跟加粗的数字和一个空格:「3 个项目」。
    resultsOne:         '个项目',
    resultsMany:        '个项目',
    resultsOneFiltered: '个项目（已筛选）',
    resultsManyFiltered:'个项目（已筛选）',

    sortNewest:  '最新',
    sortRaised:  '募资最多',
    sortClosing: '即将截止',
    sortOldest:  '最早',

    nothingMatches:  '没有匹配 *{query}* 的项目',
    emptyTitle:      '还没有项目',
    emptyPhaseTitle: '这个阶段暂无项目',
    emptyBody:       '工厂合约的创建事件一上链，第一个项目就会出现在这里。',
    emptyPhaseBody:  '换个阶段或搜索词试试。',
    clearFilters:    '清除筛选',
    clockNote:       '倒计时每秒更新，阶段每 10 秒重新归类。',
    launchCta:       '发射一个智能体 →',

    pillLive:      '募资中',
    pillLaunching: '待上线',
    pillCompleted: '交易中',
    pillArchived:  '已归档',

    noDescription: '创建者未提供描述。',

    endsIn:        '{left}后截止',
    closed:        '已截止',
    durationDays:  '{d} 天 {h} 小时',
    durationHours: '{h} 小时 {m} 分',

    raised:           '已募集',
    raisedAtGenesis:  'GENESIS 募集额',
    noPriceFeed:      '暂无价格源',
    waitingOnCreator: '等待创建者',
    refundsOpen:      '退款已开放 · 可全额取回存款',
    viewAgent:        '查看智能体 →',

    featureWaiting: '等待创建者',
    featureRaised:  'GENESIS 募集额 *{quote}*',
  },

  home: {
    settlesOn: '结算于 {chain}',

    // 三行硬换行，渐变落在最后一行。中文短语之间不加空格，组件只在拉丁字符
    // 结尾的行后补空格。
    headline: '智能体代币的|公平发射|*交易终端。*',
    lede: '用 {quote} 参与项目募资，额度由你钱包的 Gas 历史解锁；募资结束后，在 4,000 档价格阶梯上交易。'
        + '每个项目都会部署自己专属的 PancakeSwap Infinity 池子。',
    ctaLaunch:    '发射代币',
    ctaDirectory: '智能体目录',

    feedTitle: '链上动态',
    feedLive:  '工厂合约事件',
    feedEmpty: '还没有项目。工厂合约的创建事件一上链，第一个项目就会出现在这里。',

    badgeLive:      '募资中',
    badgeLaunching: '待上线',
    badgeCompleted: '交易中',
    badgeArchived:  '可退款',

    subLive:      '进行中',
    subLaunching: '窗口已关闭',
    subCompleted: 'GENESIS 募集',
    subArchived:  '可全额退款',

    teaserKicker:     '正在热门',
    teaserTitle:      '活跃市场',
    viewAll:          '查看全部',
    teaserEmptyTitle: '暂无正在交易或募资的项目',
    teaserEmptyBody:  '工厂合约的创建事件一上链，第一个项目就会出现在这里。在那之前，{chain} 上没有开放中的项目。',
    teaserEmptyCta:   '发起第一个项目',

    howKicker: '// 运作方式',
    howTitle:  'Tosh 项目是怎样发射的。',
    howLede:   '五个步骤，全部在链上结算。这里没有任何规则由本界面执行 —— 合约才是唯一的依据。',

    step1Tag:   '额度',
    step1Title: 'Gas 历史决定你的额度',
    step1Body:  'Tosh 读取你的钱包真实消耗过多少 Gas，并据此签发存款上限。今天早上刚生成的钱包没有历史可用，所以机器人批量钱包在这里一无所获。',

    // 发射费用链上原生币({native})支付，不是报价资产 —— 与第 3 步的 {quote} 不同。
    step2Tag:   '发射',
    step2Title: '任何人都可以发起',
    step2Body:  '用 {native} 支付发射费用，代币即与它专属的 PancakeSwap Infinity 池子一同部署。没有预挖，没有团队份额，也没有为内部人预留的供应。',

    step3Tag:   'Genesis',
    step3Title: '一个不能提前结束的窗口',
    step3Body:  '存款以 {quote} 进行，时长为 3、24 或 72 小时 —— 创建者在发射时一次选定，之后无法缩短。'
              + '如果募资规模太小、不足以开池，或者创建者在其后 7 天窗口内始终没有调用 launch()，每位存款人都能取回全部金额。',

    step4Tag:   'Ladder',
    step4Title: '价格一档一档往上走',
    step4Body:  'GENESIS 结束后，剩余供应分布在 4,000 个固定的 shelf 上，价格区间从开盘价一路到 2,000 倍。上限机制挡住暴涨，shelf 收入的 99% 归项目本身。',

    step5Tag:   '合约强制',
    step5Title: '规则由合约执行，而不是这个页面',
    step5Body:  '存款记账、每个钱包的存款上限和最小存款门槛，全部写在合约里。本界面只是如实显示，没有能力放宽它们。',
  },

  project: {
    badgeGenesis:  'Genesis',
    badgeAwaiting: '待上线',
    badgeLadder:   'Ladder',
    badgeRefund:   '退款开放',

    priceLabel:      '价格',
    priceHintShelf:  '当前 shelf',
    priceHintP0:     'GENESIS P₀',
    priceHintClosed: '上线后开放',
    phaseLabel:      '阶段',
    ladderLabel:     'Ladder',

    raised:          '已募集',
    raisedAtGenesis: 'GENESIS 募集额',

    outstandingReading: '→ 正在读取剩余金额…',
    outstandingNone:    '→ 退款已全部发放 · 这里已无余额',
    outstandingSome:    '→ 还有 {amount} {quote} 待领取',
    windowCaption:      '{quote} · {hours} 小时窗口',
    windowLeft:         '剩余 {clock}',
    windowClosed:       '窗口已关闭',

    stakeLabel:     '你的存款',
    stakeClaimable: '可全额取回',
    stakeNone:      '这里没有可领取的',
    stakeBonding:   'GENESIS 份额已在上线时解锁',
    stakeGenesis:   '本轮募资中',

    lifecycleTitle:   '发射进度',
    stepFunding:      '募资',
    stepFundingBody:  'Proof-of-Gas 准入的 {quote} 存款',
    stepAwaiting:     '待上线',
    stepAwaitingBody: '窗口已关闭 · 等待创建者',
    stepTrading:      '交易',
    stepTradingBody:  '4,000 档 ladder 已在 Infinity 上运行',
    stepCurrent:      '当前',
    archivedBanner:   '可全额退款 —— 创建者没有在发射窗口内开池。没有罚金，也不打折扣。',

    backToAll:       '全部项目',
    tokenLabel:      '代币',
    creatorLabel:    '创建者',
    socialX:         'X / Twitter',
    socialTg:        'Telegram',
    socialWeb:       '官网',
    headerPriceUnit: '{quote} · 当前 shelf',
    shelfPosition:   '第 {n} / {total} 档 shelf',
    about:           '项目介绍',
  },

  bonding: {
    // 嵌进 tx.* 的名词短语:「等待签名 —— 购买 QMT」。
    buyAction:   '购买 {symbol}',
    haltPending: '等待恢复',

    amountInvalidLabel:  '请检查数量',
    amountInvalidReason: '这不是一个可以作为代币数量提交的数字。',
    amountZeroLabel:     '请输入数量',
    amountZeroReason:    '输入要购买的 {symbol} 数量。',
    haltedLabel:         '已暂停 · {time} 后恢复',
    haltedReasonGlobal:  '协议熔断器已在全平台暂停 shelf 铸造 —— {time} 后自动解除，期间池子照常交易。',
    haltedReasonHook:    '协议熔断器已暂停本项目的 shelf 铸造 —— {time} 后自动解除，期间池子照常交易。',
    sameBlockLabel:      '本区块暂停',
    sameBlockReason:     '本区块内已有一笔兑换，合约不会在同一区块里从 shelf 出售。下一个区块即恢复。',
    exceedsLabel:        '数量过大',
    exceedsReason:       '单笔购买目前最多 {max} —— 剩下的请分第二笔交易发送。',
    awaitingLabel:       '等待市场价格',
    awaitingReason:      '按设计，第一档 shelf 比池子价格高 5%，要等市场价格涨到这一档才会开放。',
    lockedLabel:         '高于价格上限',
    lockedReason:        '下一档 shelf 比当前池子价格高出 5% 以上，要等市场价格跟上来才会开放。',
    noCapacityLabel:     '暂无可购供应',
    noCapacityReason:    '目前没有任何一档 shelf 能成交 —— ladder 要么已售罄，要么在边际上价格超限。',
    quotePendingLabel:   '正在查询价格…',
    quotePendingReason:  '正在计算 {symbol} 在当前 shelf 的价格。价格一返回，按钮就会亮起。',
    quoteUnavailableLabel:  '无法获取价格',
    quoteUnavailableReason: '这个数量没有返回价格，所以无法发起交易。通常是网络波动 —— 每隔几秒会自动重试。',
    dustLabel:           '数量过小',
    dustReason:          '这个数量的价格低于 shelf 能收取的最小 {quote} 单位。请调大数量，让订单至少值 0.00000001 {quote}。',
    balanceLabel:        '{quote} 余额不足',
    balanceReason:       '此钱包的余额不够支付报价加滑点余量 —— 合计 {amount} {quote}。',
    approvingLabel:      '授权中…',
    approveLabel:        '授权 {amount} {quote}',
    approveReason:       'shelf 是从你的钱包里拉取 {quote}，而不是由你转账，所以需要最多 {amount} {quote} 的授权 —— 即报价加滑点余量。它只会扣实际成本，差额仍归你。',

    errNotNumber: '不是数字',
    errTooBig:    '超出单笔上限',
    errDust:      '低于最小单位',
    errBalance:   '超出余额',
    hintSameBlock: '本区块内 ladder 暂停 —— 下一个区块恢复',
    hintAwaiting:  '市场价格到达第一档 shelf 后 ladder 开放',
    hintMax:       '单笔最多 {max} · 可跨多档 shelf',

    ladderTitle:     'SHELF LADDER · {symbol}',
    ladderSubtitle:  '每笔买入都落在当前 shelf 上。已清空的 shelf 留在下方；排队中的 shelf 会在当前这档售完后开放。',
    suspendedGlobal: '→ LADDER 已暂停 · 全平台 · {time} 后解除',
    suspendedHook:   '→ LADDER 已暂停 · 本项目 · {time} 后解除',
    suspendedBody:   '协议所有者触发了熔断器，到期前合约会拒绝所有 shelf 购买。池子本身不受影响 —— 代币仍在 PancakeSwap 上交易，已有余额不受影响，熔断到期后自动解除，无需任何操作。',

    buyTitle:          '购买 ${symbol}',
    buyEyebrow:        'shelf ladder',
    amountLabel:       '购买数量',
    amountPlaceholder: '例如 1000',
    quotedCost:        '报价',
    unavailable:       '不可用',
    mostYouPay:        '最多支付',
    mostYouPayHint:    '比报价高 0.5%；只按实际成本扣款',
    orderSize:         '订单规模',
    belowMinimum:      '低于最小值',
    accepted:          '可以成交',
    orderSizeHint:     '请调大数量，让订单至少值 0.00000001 {quote}',
    buyFooter:         '一笔订单会按需跨越多档 shelf，105% 价格上限防止它在远高于市价的位置成交。',

    gateHalted:    'LADDER 已熔断',
    gateSameBlock: '105% 闸门 · 同区块锁定',
    gateAwaiting:  '105% 闸门 · 等待市场',
    gateOpen:      '105% 闸门 · 开放',
    gateLocked:    '105% 闸门 · 锁定',
    shelfPrice:    'SHELF 价格',
    perToken:      '每枚代币',
    remaining:     '剩余',
    tokensOnRung:  '本档剩余代币',
    ceiling:       '105% 上限',
    ceilingTracks: '跟随池子价格及其均价',
    ceilingHeld:   '固定在开盘价',
    fillLabel:     'SHELF #{n} 进度',
    rowLive:       '当前',
    rowCleared:    '已清空',
    rowQueued:     '排队中',
    footOpening:  '开盘价 = *{price} {quote}*',
    footNow:      '现价 = *{price}*',
    footAverage:  '均价 = *{price}*',
    footAverageSettling: '均价 = *计算中 · {window} 窗口 · 上限固定在开盘价*',
  },

  liquidity: {
    // 名词短语，套进「等待签名 — …」。
    txAction:     '流动性',
    connectFirst: '请先连接钱包',

    title:            '你的流动性 · {symbol}/{quote}',
    subtitle:         'Infinity PositionManager · 全区间 · 0.30% 池子手续费归 LP 所有',
    poolDepth:        '池子深度 · {asset}',
    poolDepthHint:    '所有 LP，含 genesis 仓位',
    myPosition:       '我的仓位 · {asset}',
    positionsOne:     '{n} 个仓位',
    positionsMany:    '{n} 个仓位',
    withdrawableHint: '随时可取回',

    depositLabel:       '存入的 {quote} 数量',
    depositPlaceholder: '例如 5',
    hintPairs:          '按当前价格需配对 {amount} {symbol}',
    hintIdle:           '全区间 · 两种资产都需要 · 随时可取回',
    errNotNumber:       '不是数字',
    errAboveBalance:    '超出你的 {quote} 余额',
    errNeedsMore:       '需要更多 {symbol}',

    slippage:      '滑点',
    slippageGroup: 'LP 滑点容忍度',

    stepToPermit2:   '{asset} →P2',
    stepFromPermit2: 'P2 →{asset}',
    stepDeposit:     '存入',

    // 英文这里仍写着「Step 3 of 3」，是旧文案，实际是 5 步中的第 5 步。中文按实际编号。
    action: '第 5 步（共 5 步）：存入资金池',

    clockLabel:     '正在同步时钟…',
    clockReason:    '下面每一笔签名都带有一个根据系统时钟算出的截止时间。时钟同步之前，这个截止时间会落在 1970 年，Permit2 会拒绝这个仓位。',
    tokenLabel:     '正在加载代币…',
    tokenReason:    '仍在读取本项目的代币地址。',
    invalidLabel:   '请检查数量',
    invalidReason:  '这个数值无法作为 {quote} 发送。',
    zeroLabel:      '请输入数量',
    zeroReason:     '输入要存入资金池的 {quote} 数量。',
    priceLabel:     '池子价格暂不可用',
    priceReason:    '池子价格还没有返回，没有它就无法计算全区间仓位的大小。',
    bitmapLabel:    '正在读取池子参数…',
    bitmapReason:   'hook 的权限位图还没有返回，没有它就无法编码 PoolKey。',
    readsLabel:     '正在读取你的钱包…',
    readsReason:    '仍在读取这个钱包的 {symbol} 余额和 Permit2 授权。下一步取决于这两项，所以等数据返回后再给出，而不是现在猜测。',
    quoteLowLabel:  '{quote} 不足',
    quoteLowReason: '这个钱包的余额不够支付存入金额加上 {pct}% 的滑点余量。',
    tokenLowLabel:  '{symbol} 不足',
    tokenLowReason: '全区间仓位需要同时存入两种资产。这个仓位需要 {needed} {symbol}，钱包里只有 {held}。',
    dustLabel:      '数量太小',
    dustReason:     '按当前价格，这笔存入太小，无法增加任何流动性。请提高数量。',

    step1Label:  '第 1 步（共 5 步）：为 Permit2 授权 {symbol}',
    step1Reason: 'Permit2 需要先获得一次性的 {symbol} 授权，才能调动仓位中的代币部分。',
    step2Label:  '第 2 步（共 5 步）：允许 Permit2 使用你的 {symbol}',
    step2Reason: 'Permit2 已持有 {symbol} 授权，但还没有被告知仓位管理合约（position manager）可以从中支取。',
    step3Label:  '第 3 步（共 5 步）：为 Permit2 授权 {quote}',
    step3Reason: '另一种资产现在是 {quote}，而不是链上原生币，所以它和代币一样由合约拉取，而不是随交易一起发送。Permit2 需要单独获得一次性的 {quote} 授权。',
    step4Label:  '第 4 步（共 5 步）：允许 Permit2 使用你的 {quote}',
    step4Reason: '和第 2 步相同，针对 {quote} 部分：Permit2 为每种代币单独给仓位管理合约开放一个支取期限，而这个期限已经过期或从未开放。',

    openPositions: '持有的仓位',
    withdraw:      '取回',
    degraded:      '这个 RPC 节点不提供仓位日志，所以只列出了在本浏览器中创建的仓位。你的其他仓位在链上是安全的，仍可通过任何 PancakeSwap Infinity 界面取回。',
    coverage:      '仓位查找只扫描最近 {window}的转账记录。更早的、在其他浏览器中创建的仓位不会在这里列出，但它们在链上仍归你所有，并可通过任何 PancakeSwap Infinity 界面取回。',
    coverageHours: '{n} 小时',
    coverageDays:  '{n} 天',
  },

  gas: {
    txAction:          'PoG 额度登记',
    connectFirst:      '请先连接钱包',
    unsupportedChain:  '不支持的链（当前为 {chain}）',
    noChain:           '无',
    notEligible:       '这个钱包暂时还不符合存款额度条件。',
    quotaToast:        '额度已核定 · {amount} {quote}',
    lowerBoundMissing: '{chains} 无法读取；这个总数只是下限。',
    lowerBoundPaged:   '部分历史记录太多，无法全部翻页读取；这个总数只是下限。',
    listSeries:        '{a}、{b}',
    listLast:          '{a} 和 {b}',
    listEvery:         '{a}、{b}',

    title:           'Gas 明细',
    close:           '关闭',
    noteUnavailable: '无法读取',
    noteSkipped:     '已跳过（已达上限）',
    noteLowerBound:  '下限',
    txCount:         '{n} 笔交易',
    scanning:        '正在读取你在 {chains} 上的累计 gas。需要几秒钟，不需要签名。',
    failed:          'gas 查询失败。',
    retry:           '重试',
    intro:           '你发送交易累计花费的 gas，数据来自公开的区块浏览器。这次查询不需要钱包签名。',
    total:           '合计',
    floor:           '门槛',
    quotaSized:      '核定额度',
    // Historical gas figure: ETH here is the PoG denomination, not the settlement coin.
    unitsNote:       'gas 以 ETH 计量，因为扫描的这些链都以 ETH 结算；额度以 {quote} 计量，因为你存入的就是它。',
    missing:         '{chains} 无法读取，所以这个总数可能偏低。',
    activateBody:    '符合条件。激活会把额度写到链上（一次签名、一笔交易）。之后存款就不再需要检查 gas。',
    activate:        '激活存款额度',
    activating:      '正在激活额度…',
    onFile:          '符合条件 —— 这个钱包的存款额度已经登记。',
    // Historical gas figure: ETH here is the PoG denomination, not the settlement coin.
    belowFloor:      '低于门槛 —— 历史 gas 为 {total} ETH，门槛是 {floor} ETH。在达到门槛之前，这个钱包无法存款。',
  },

  referral: {
    txAction:      '推荐佣金领取',
    action:        '领取佣金',
    nothingLabel:  '暂无可领取',
    nothingReason: '这个钱包还没有累计任何佣金 —— 有人通过你的链接存款时才会累计，项目上线时解锁。',

    title:    '推荐台',
    subtitle: '通过你的链接在本项目的存款计 {project}%，你带来 Tosh 的钱包终身再计 {lifetime}% · 项目上线时发放',

    noneHeadline: '这个链接目前还不产生佣金',
    noneDetail:   '两部分佣金都要求你本人先完成 PoG 认证。认证之后，同一个链接就会开始按 {total}% 计佣。[去认证 PoG]。',
    partHeadline: '这个链接只按 {lifetime}% 计佣，而不是 {total}%',
    partDetail:   '{project}% 这部分只会绑定给已经在本项目存过款的推荐人。你存款之后，从下一笔存款起开始计佣。[先去存款]。',
    fullHeadline: '这个链接按完整的 {total}% 计佣',
    fullDetail:   '本项目存款的 {project}%，加上 Tosh 新钱包的终身 {lifetime}%。',

    linkLabel:  '你的推荐链接',
    copy:       '复制',
    copyAnyway: '仍然复制',
    copied:     '已复制',
    bindSummary: '两部分佣金如何绑定',
    bindHow:    '钱包第一次通过本项目的链接进来时，会在本项目绑定给你，计 {project}%。如果这也是这个钱包用过的第一个 Tosh 链接，它今后在任何项目的全部存款，你都终身获得 {lifetime}%。两种绑定都是永久的，工厂合约会忽略自我推荐。',
    bindSilent: '没绑定上的那部分不会报错，也没人看得到：存款照常成功，这份佣金会进入回购池，而不是给你。工厂合约在每一笔存款时都会重新尝试绑定，所以已经发出去的链接，一旦满足条件就会开始计佣。',

    claimLabel:  '可领取佣金',
    earnedHint:  '已赚取 {amount} {quote} · launch() 后解锁',
    ledgerLink:  '所有项目的佣金',
  },

  publish: {
    action: '发布项目资料',
    toast:  '项目资料已发布',

    resolvingLabel:  '正在查找你的发射交易',
    resolvingReason: '正在从链上读取创建这个项目的交易。',
    noHashLabel:     '需要填写创建交易',
    noHashReason:    '请粘贴把这个项目带上链的 createLaunch 交易 —— 签名里必须写明它。',
    logoLabel:       '正在等待图片上传',
    logoReason:      '需要先等上传完成：你签名的内容里包含图标地址。',

    title:    '这个项目还没有上架',
    subtitle: '它的发射已经上链，但图标、链接和简介从未进入项目目录 —— 发布只需要一次签名，不花 gas',
    body:     '在完成这一步之前，{symbol} 在目录里只会显示一个字母图标，没有简介，因为下面这些内容都存放在链下，而登记表里还没有它的记录。',
    notAGate: '这只是目录里的展示资料，别无其他。存款、退款和触发上线都直接读取链上数据 —— 它们都不依赖这一步，即使你永远不发布，它们也不会有任何变化。',

    description:            '简介',
    descriptionPlaceholder: '这个项目是做什么的。',
    website:                '网站',
    hashLabel:              '创建交易',
    hashHint:               '暂时没能查到 —— 刷新页面也许能找到。否则请从钱包历史或区块浏览器里复制 createLaunch 交易哈希，也就是把这个项目带上链的那一笔。',

    footer: '这次签名只证明你是这个项目的创建者，别无他用 —— 它不发送交易，也不授予任何支出权限。只有创建这个项目的钱包才能发布它的资料。',
  },
}
