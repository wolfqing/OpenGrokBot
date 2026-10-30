import { useEffect, useState } from 'react'

/**
 * 本机电脑的屏幕：网关把浏览器的截屏流一帧一条 JSON 推过来，这里换图就行。只看不操作——
 * 要接管（登录）时浏览器会以真窗口开到桌面上，那里才是输入的地方。
 */
export function CdpScreen({ url, title }: { url: string; title: string }) {
  const [frame, setFrame] = useState<string | null>(null)
  const [status, setStatus] = useState('Connecting…')

  useEffect(() => {
    let closed = false
    let retry = 0
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${url}`)
      ws.onopen = () => { retry = 0 }
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as { type: string; data?: string; error?: string }
          if (m.type === 'frame' && m.data) {
            setFrame(`data:image/jpeg;base64,${m.data}`)
            setStatus('')
          } else if (m.type === 'error') {
            setStatus(m.error ?? 'No screen')
          }
        } catch { /* 忽略脏帧 */ }
      }
      ws.onclose = () => {
        if (closed) return
        setStatus('Reconnecting…')
        timer = setTimeout(open, Math.min(1000 * 2 ** retry++, 15000))
      }
    }
    open()
    return () => {
      closed = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [url])

  return (
    <div className="panel-screen panel-screen-cdp" role="img" aria-label={title}>
      {frame ? <img src={frame} alt="" /> : null}
      {status ? <div className="panel-screen-status">{status}</div> : null}
    </div>
  )
}
