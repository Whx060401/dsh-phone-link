/**
 * Client half of the phone bridge: a scannable QR panel under the composer.
 * It reads the bridge port from the page global the Host injects and fetches
 * the current link data from the loopback bridge server.
 */
window.__ModuleLoader__.load({
  id: 'dsh-phone-link',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const cardStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '10px 12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 12,
      background: 'var(--dsw-alias-bg-layer-2)',
      maxWidth: 560,
    }
    const qrBoxStyle = {
      flex: 'none',
      background: '#ffffff',
      padding: 8,
      borderRadius: 10,
      lineHeight: 0,
    }
    const pillStyle = {
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-secondary)',
      borderRadius: 10,
      padding: '5px 10px',
      fontSize: 12,
      cursor: 'pointer',
    }
    const smallButton = {
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 8,
      padding: '3px 8px',
      fontSize: 12,
      cursor: 'pointer',
    }
    const linkStyle = {
      color: 'var(--dsw-alias-brand-primary)',
      fontSize: 12,
      alignSelf: 'center',
      textDecoration: 'none',
    }

    function bridgePort() {
      const injected = window.__DSH_PHONE_BRIDGE__
      return injected !== null && typeof injected === 'object' && typeof injected.port === 'number'
        ? injected.port
        : 8765
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [expanded, setExpanded] = useState(true)
      const [copied, setCopied] = useState(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const load = useCallback(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${bridgePort()}/api/link`, { cache: 'no-store' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const next = await response.json()
          if (!alive.current) return
          setData(next)
          setError('')
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 20000)
        return () => clearInterval(timer)
      }, [load])

      const publicLink = data && typeof data.publicLink === 'string' ? data.publicLink : ''
      const lan = data && Array.isArray(data.lanLinks) ? data.lanLinks.find(item => typeof item.link === 'string') : undefined
      const link = publicLink !== '' ? publicLink : (lan ? lan.link : '')
      const qr = publicLink !== '' ? data.publicQr : (lan ? lan.qr : '')

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(link)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          setError('复制失败，请打开链接页复制')
        }
      }

      if (!expanded) {
        return h('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '2px 0' } },
          h('button', { type: 'button', style: pillStyle, onClick: () => setExpanded(true) }, '手机扫码连接'))
      }

      return h('div', { style: cardStyle },
        h('style', null, '.dsh-phone-bridge-qr svg{display:block;width:132px;height:132px}'),
        qr
          ? h('div', { style: qrBoxStyle, className: 'dsh-phone-bridge-qr', dangerouslySetInnerHTML: { __html: qr } })
          : null,
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
            h('span', {
              style: {
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: publicLink !== ''
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-state-idle-primary)',
              },
            }),
            '手机遥控',
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } },
              publicLink !== '' ? '微信扫码 · 任何网络' : '微信扫码 · 局域网')),
          h('div', {
            style: {
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary)',
              wordBreak: 'break-all',
              marginTop: 2,
              maxHeight: 34,
              overflow: 'hidden',
            },
          }, link !== '' ? link : '正在获取链接…'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' } },
            link !== ''
              ? h('button', { type: 'button', style: smallButton, onClick: copy }, copied ? '已复制' : '复制链接')
              : null,
            h('button', { type: 'button', style: smallButton, onClick: () => setExpanded(false) }, '收起'),
            h('a', {
              href: `http://127.0.0.1:${bridgePort()}/link`,
              target: '_blank',
              rel: 'noreferrer',
              style: linkStyle,
            }, '链接页')),
          error !== ''
            ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } },
              '连不上手机页面：' + error)
            : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'phone-bridge-qr',
          order: 20,
        }, Panel))
      },
    }
  },
})
