import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { ApprovalChip } from '../components/ApprovalChip'
import { ComputerPanel } from '../components/ComputerPanel'
import { Sidebar } from '../components/Sidebar'
import { Thread } from '../components/Thread'
import type { ComputerInfo, Conversation, Message } from '../types'
import { I18nProvider } from './index'

/** 每个主界面用中文渲染一次：看得到中文，同事的名字和它说的话原样不动 */
const zh = (ui: ReactNode) => render(<I18nProvider lang="zh-CN">{ui}</I18nProvider>)

const dm: Conversation = {
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null, pending: 2,
}

describe('in Chinese', () => {
  it('the sidebar', () => {
    zh(<Sidebar conversations={[dm]} selectedId={null} statuses={{ researcher: 'blocked' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByRole('button', { name: '雇一位同事' })).toBeInTheDocument()
    expect(screen.getByText('卡住了')).toBeInTheDocument()
    expect(screen.getByText('打个招呼，交代第一件事。')).toBeInTheDocument()
    expect(screen.getByLabelText('2 件事等你')).toBeInTheDocument()
    expect(screen.getByText('Scout')).toBeInTheDocument()
  })

  it('the thread', () => {
    const now = Date.now()
    const messages: Message[] = [
      { id: 1, thread_id: dm.id, sender: 'user', kind: 'text', content: 'scan the web', payload: null, created_at: now },
      { id: 2, thread_id: dm.id, sender: 'researcher', kind: 'approval_resolved', content: '', created_at: now,
        payload: { approvalId: 1, decision: 'approve', action: 'send the drafts', count: { approved: 2, of: 3 } } },
    ]
    zh(<Thread conversation={dm} roster={{}} messages={messages} thinking onSend={() => {}} onDecide={() => {}} onStop={() => {}} onOpenScreen={() => {}} />)
    expect(screen.getByText('今天')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('给 Scout 发消息')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停下' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开它的电脑' })).toBeInTheDocument()
    expect(screen.getByText(/✓ 已批准 · send the drafts · 3 项里批了 2 项/)).toBeInTheDocument()
    expect(screen.getByText('scan the web')).toBeInTheDocument()
  })

  it('an approval', () => {
    zh(<ApprovalChip
      payload={{ approvalId: 7, action: 'send the 4 queued drafts', status: 'pending', kind: 'email', target: 'bob@acme.com', canRemember: true, ruleHeld: 'routine' }}
      onDecide={() => {}}
    />)
    expect(screen.getByText('等你审批')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '一直放行…' })).toBeInTheDocument()
    expect(screen.getByText(/你的放行规矩管得到email → bob@acme.com.*这件事是例行任务开的头，不是你/)).toBeInTheDocument()
  })

  it('the computer panel', () => {
    const info: ComputerInfo = {
      botId: 'researcher', running: true, vncUrl: null, kind: 'local',
      shell: { enabled: false, available: false },
      routines: [{ id: 1, name: 'Morning digest', cron: '0 9 * * *', human: 'every day at 09:00', last_run_at: null, enabled: 0 }],
      usage: { today: { prompt: 1, completion: 1, cached: 0, total: 12345 }, budget: 200000 },
    }
    zh(<ComputerPanel info={info} botName="Scout" onClose={() => {}} onRoutine={() => {}} />)
    expect(screen.getByText('Scout 的电脑')).toBeInTheDocument()
    expect(screen.getByText('现在没有屏幕')).toBeInTheDocument()
    expect(screen.getByText(/^本机电脑：/)).toBeInTheDocument()
    expect(screen.getByText(/这里用不了：这台机器上没有沙箱/)).toBeInTheDocument()
    expect(screen.getByText('已暂停')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复 Morning digest' })).toBeInTheDocument()
    expect(screen.getByText('12,345 个 token，预算 200,000')).toBeInTheDocument()
  })

  it('while the computer wakes', () => {
    zh(<ComputerPanel info={null} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('正在启动 Scout 的电脑…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })
})
