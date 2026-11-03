import { useEffect, useState } from 'react'

/**
 * 本机电脑的屏幕：网关把浏览器的截屏流一帧一条 JSON 推过来，这里换图就行。只看不操作——
 * 要接管（登录）时浏览器会以真窗口开到桌面上，那里才是输入的地方。
 * 断线就按退避重连（浏览器重开时网关会主动断一次）；网关说「没有屏幕」就停下，别一遍遍把它的电脑拉起来；
 * 标签页藏到后面时也断开，省得后台还在收 10 帧/秒的图。
 */
export function CdpScreen({ url, title }: { url: string; title: string }) {
  const [frame, setFrame] = useState<string | null>(null)
  const [status, setStatus] = useState('Connecting…')

  useEffect(() => {
    let closed = false
    let fatal = false
    let retry = 0
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      if (closed || fatal || document.hidden) return
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${url}`)
      ws.onopen = () => { retry = 0 }
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as { type: string; data?: string; error?: string }
          if (m.type === 'frame' && m.data) {
            setFrame(`data:image/jpeg;base64,${m.data}`)
            setStatus('')
          } else if (m.type === 'error') {
            fatal = true
            setStatus(m.error ?? 'No screen')
          }
        } catch { /* 忽略脏帧 */ }
      }
      ws.onclose = () => {
        ws = null
        if (closed || fatal) return
        setStatus('Reconnecting…')
        timer = setTimeout(open, Math.min(1000 * 2 ** retry++, 15000))
      }
    }
    const onVisibility = () => {
      if (document.hidden) ws?.close()
      else if (!ws) { clearTimeout(timer); open() }
    }
    document.addEventListener('visibilitychange', onVisibility)
    open()
    return () => {
      closed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      ws?.close()
    }
  }, [url])

  return (
    <>
      <div className="panel-screen panel-screen-cdp">
        {frame ? <img src={frame} alt={title} /> : null}
      </div>
      {status ? <div className="panel-screen-status" role="status">{status}</div> : null}
    </>
  )
}
