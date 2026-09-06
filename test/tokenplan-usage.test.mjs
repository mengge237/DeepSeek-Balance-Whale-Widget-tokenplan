// 纯逻辑单测：node test/tokenplan-usage.test.mjs
// 覆盖 Token Plan 估算口径、7 天窗口数学、账本合并、告警去重。
import assert from 'node:assert/strict'
import * as TP from '../lib/tokenplan-usage.js'

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok  ' + name)
  } catch (err) {
    console.log('  FAIL ' + name + ' -> ' + (err && err.message))
    process.exitCode = 1
  }
}

const DAY = TP.DAY_MS
const dayKey = (n) => TP.localDayKey(n)

t('priceForModel 与 token_plan_report.py RATES 对齐', () => {
  assert.deepEqual(TP.priceForModel('qwen3.8-flash'), { price: [0.8, 2.7, 0.1], known: true })
  assert.deepEqual(TP.priceForModel('QWEN3.8-MAX'), { price: [12, 36, 1.5], known: true })
  assert.deepEqual(TP.priceForModel('glm-5.2'), { price: [8, 28, 2], known: true })
  // 未知模型：退回 qwen3.8-flash 价目并标 known=false（宁可估高也不漏计）
  const fb = TP.priceForModel('nope-9')
  assert.equal(fb.known, false)
  assert.deepEqual(fb.price, TP.priceForModel('qwen3.8-flash').price)
})

t('estimateUsage：reasoning 并入输出、cacheRead+cacheWrite 并入缓存、Credits=¥×100', () => {
  const e = TP.estimateUsage('qwen3.8-flash', {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    reasoningTokens: 20_000,
    cacheReadTokens: 500_000,
    cacheWriteTokens: 10_000,
  })
  // 输入不含缓存部分：harness 的 inputTokens 已是非缓存输入
  const payg = (1e6 * 0.8 + 120_000 * 2.7 + 510_000 * 0.1) / 1e6
  assert.ok(Math.abs(e.payg - payg) < 1e-9, 'payg ' + e.payg + ' vs ' + payg)
  assert.ok(Math.abs(e.credits - payg * 100) < 1e-9)
  assert.equal(e.tokens, 1e6 + 120_000 + 510_000)
  assert.equal(e.calls, 1)
  assert.equal(e.known, true)
})

t('estimateUsage：未知模型计 0 但标记 known=false；校准系数生效', () => {
  const mystery = TP.estimateUsage('mystery', { inputTokens: 100, outputTokens: 10 })
  assert.equal(mystery.known, false)
  assert.ok(mystery.credits > 0, '未知模型按兜底价目估算而非 0')
  const k = TP.estimateUsage('qwen3.8-flash', { inputTokens: 1_000_000 }, 2)
  assert.ok(Math.abs(k.credits - 0.8 * 100 * 2) < 1e-6)
})

t('parseLedger 只取指定 provider，并把 calls 带出来', () => {
  const doc = {
    days: {
      '2026-09-05': {
        tokenplan: { 'qwen3.8-flash': { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, calls: 3 } },
        deepseek: { 'deepseek-v4-flash': { inputTokens: 9, outputTokens: 9, calls: 9 } },
      },
    },
  }
  const days = TP.parseLedger(doc, 'tokenplan')
  assert.deepEqual(Object.keys(days), ['2026-09-05'])
  assert.equal(days['2026-09-05'].calls, 3)
  assert.ok(days['2026-09-05'].models['qwen3.8-flash'].credits > 0)
})

t('mergeDays 逐日取 max，绝不相加（同一批调用不能计两次）', () => {
  const ledger = { '2026-09-05': { credits: 100, payg: 1, tokens: 1000, calls: 10, models: {}, unknown: {} } }
  const self = { '2026-09-05': { credits: 90, payg: 0.9, tokens: 900, calls: 9, models: {}, unknown: {} } }
  const m = TP.mergeDays(ledger, self)
  assert.equal(m.days['2026-09-05'].credits, 100)
  assert.equal(m.source, 'ledger+live')
})

t('resolveAnchor + currentWindow：锚点即第 1 天，7 天后翻窗口', () => {
  const anchor = Date.UTC(2026, 8, 5, 3, 0, 0)
  const w0 = TP.currentWindow(anchor, anchor)
  assert.equal(w0.dayIndex, 1)
  assert.equal(w0.index, 0)
  const w6 = TP.currentWindow(anchor, anchor + 6 * DAY + 1000)
  assert.equal(w6.dayIndex, 7)
  const w7 = TP.currentWindow(anchor, anchor + 7 * DAY)
  assert.equal(w7.dayIndex, 1)
  assert.equal(w7.index, 1)
  assert.equal(TP.resolveAnchor('bogus', [], anchor).anchorSource, 'now')
  assert.equal(TP.resolveAnchor('', [dayKey(anchor + 3 * DAY)], anchor + 5 * DAY).anchorSource, 'first-usage-day')
})

t('alertLevel 阈值分档', () => {
  assert.equal(TP.alertLevel(69.9, 70), 'ok')
  assert.equal(TP.alertLevel(70, 70), 'warn')
  assert.equal(TP.alertLevel(90, 70), 'high')
  assert.equal(TP.alertLevel(100, 70), 'exhausted')
})

t('isTokenPlanCall：provider 优先，模型名兜底，百炼同名模型不串账', () => {
  const cfg = TP.normalizeConfig({})
  assert.equal(TP.isTokenPlanCall(cfg, 'tokenplan', 'qwen3.8-flash'), true)
  assert.equal(TP.isTokenPlanCall(cfg, 'bailian', 'qwen3.8-flash'), false)
  assert.equal(TP.isTokenPlanCall(cfg, 'tokenplan', 'glm-5.2'), true) // 套餐里不止 qwen
  assert.equal(TP.isTokenPlanCall(cfg, 'deepseek', 'deepseek-chat'), false)
  assert.equal(TP.isTokenPlanCall(cfg, '', 'qwen3.6-plus'), true)
  assert.equal(TP.isTokenPlanCall({ enabled: false }, 'tokenplan', 'qwen3.8-flash'), false)
})

t('summarize：空账本降级为 ok=false + NO_DATA，不抛异常', () => {
  const s = TP.summarize({ ledgerDays: {}, selfDays: {}, cfg: TP.normalizeConfig({}), nowMs: Date.now() })
  assert.equal(s.ok, false)
  assert.equal(s.error, 'NO_DATA')
  assert.equal(s.estimated, true)
  assert.equal(s.cap, 10000)
  assert.equal(s.used, 0)
  assert.equal(s.series.length, 7)
})

t('summarize：窗口/百分比/ROI/按模型排名一次算全', () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0)
  const mk = (credits, models) => ({
    credits,
    payg: credits / 100,
    tokens: credits * 1000,
    calls: 5,
    models,
    unknown: {},
  })
  const days = {
    '2026-09-05': mk(300, { 'qwen3.8-flash': { credits: 200, tokens: 1, calls: 4 } }),
    '2026-09-04': mk(100, { 'qwen3.8-max': { credits: 100, tokens: 1, calls: 1 } }),
  }
  const s = TP.summarize({
    ledgerDays: {},
    selfDays: days,
    cfg: TP.normalizeConfig({ qwenWindowAnchor: '2026-09-03' }),
    nowMs: now,
  })
  assert.equal(s.ok, true)
  assert.equal(s.anchorSource, 'config')
  assert.equal(s.dayIndex, 3)
  assert.equal(s.used, 400)
  assert.equal(s.remaining, 9600)
  assert.equal(s.pct, 4)
  assert.equal(s.byModel[0].model, 'qwen3.8-flash')
  assert.equal(s.byModel.length, 2)
  assert.ok(Math.abs(s.payg.roiPercent - (4 / 139) * 100) < 0.1, 'roi ' + s.payg.roiPercent)
  assert.equal(s.alert.level, 'ok')
  assert.equal(s.shouldAnnounce === undefined, true) // 由服务端补
})

t('shouldAnnounce：同窗口同级只报一次，升档或换窗可再报', () => {
  const ws = 1_000_000_000
  const now = ws + DAY
  let st = null
  assert.equal(TP.shouldAnnounce(st, 'warn', ws, now), true)
  st = TP.markAnnounced(st, 'warn', ws, now)
  assert.equal(TP.shouldAnnounce(st, 'warn', ws, now + 1000), false)
  assert.equal(TP.shouldAnnounce(st, 'high', ws, now + 1000), true)
  st = TP.markAnnounced(st, 'high', ws, now + 1000)
  assert.equal(TP.shouldAnnounce(st, 'high', ws + 7 * DAY, now + 7 * DAY), true)
  assert.equal(TP.shouldAnnounce(st, 'ok', ws + 7 * DAY, now), false)
})

t('normalizeConfig：越界与脏数据回落默认值', () => {
  const cfg = TP.normalizeConfig({ qwenCap: -5, qwenWarnPct: 900, qwenCalib: 'x', qwenTier: 'pro', qwenWindowAnchor: 123 })
  assert.equal(cfg.cap, 40000) // tier 生效
  assert.equal(cfg.warnPct, 100) // 越界先 clamp，不静默回默认
  assert.equal(cfg.calib, 1)
  assert.equal(cfg.windowAnchor, '')
  assert.equal(TP.normalizeConfig({ qwenCap: 2500 }).cap, 2500)
})

t('fmtCreditsShort 单位收敛', () => {
  assert.equal(TP.fmtCreditsShort(999.6), '1000')
  assert.equal(TP.fmtCreditsShort(12345), '12k')
  assert.equal(TP.fmtCreditsShort(1_234_567), '1.23M')
  assert.equal(TP.fmtCreditsShort(0), '0')
})

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (有失败)' : ''))
