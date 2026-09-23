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
}
