window.__ModuleLoader__.load({
  id: 'dsh-work-log',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/work-log/config'

    const box = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '14px 16px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
      borderRadius: 12,
      background: 'var(--dsw-alias-bg-l1, transparent)',
      color: 'inherit',
    }
    const label = { fontSize: 13, fontWeight: 500, lineHeight: '20px' }
    const hint = { fontSize: 12, lineHeight: '18px', opacity: 0.65 }
    const row = { display: 'flex', gap: 8, alignItems: 'center' }
    const input = {
      flex: 1,
      minWidth: 0,
      height: 34,
      padding: '0 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.18))',
      background: 'var(--dsw-alias-bg-l2, rgba(0,0,0,0.03))',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
    }
    const button = {
      height: 34,
      padding: '0 14px',
      borderRadius: 8,
      border: 0,
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 13,
      fontWeight: 500,
      background: 'var(--dsw-alias-label-primary, #0f1115)',
      color: 'var(--dsw-alias-label-primary-inverted, #fff)',
      whiteSpace: 'nowrap',
    }

    function Panel() {
      const [loading, setLoading] = React.useState(true)
      const [root, setRoot] = React.useState('')
      const [enabled, setEnabled] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch(API, { cache: 'no-store' })
          .then(response => response.json().then(value => ({ ok: response.ok, value })))
          .then(({ ok, value }) => {
            if (!alive) return
            if (!ok) throw new Error(value && value.error ? value.error : '读取失败')
            setRoot(typeof value.root === 'string' ? value.root : '')
            setEnabled(value.enabled !== false)
            setLoading(false)
          })
          .catch(error => {
            if (!alive) return
            setLoading(false)
            setNotice('宿主接口还没就绪，重启一次 DSH 后再试：' + (error && error.message ? error.message : error))
          })
        return () => { alive = false }
      }, [])

      const save = () => {
        setSaving(true)
        setNotice('')
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root, enabled }),
        })
          .then(response => response.json().then(value => ({ ok: response.ok, value })))
          .then(({ ok, value }) => {
            if (!ok || value.ok === false) throw new Error(value && value.error ? value.error : '保存失败')
            setRoot(value.root)
            setEnabled(value.enabled !== false)
            setNotice('已保存。之后的对话会写到 ' + value.root)
          })
          .catch(error => setNotice('保存失败：' + (error && error.message ? error.message : error)))
          .finally(() => setSaving(false))
      }

      return h('div', { style: box, 'data-work-log': 'config' },
        h('div', { style: label }, '工作记录 · 日志根目录'),
        h('div', { style: hint },
          '每个工作区一个子目录，每个对话一个 JSON。改完保存即可，下一轮对话就写到新位置。'),
        h('div', { style: row },
          h('input', {
            style: input,
            value: root,
            spellCheck: false,
            placeholder: 'E:\\DSH-WorkLogs',
            disabled: loading || saving,
            onChange: event => setRoot(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') save() },
            'aria-label': '工作记录根目录',
          }),
          h('button', {
            type: 'button',
            style: { ...button, opacity: loading || saving ? 0.5 : 1 },
            disabled: loading || saving,
            onClick: save,
          }, saving ? '保存中…' : '保存'),
        ),
        h('label', { style: { ...row, gap: 6, fontSize: 13, opacity: loading ? 0.5 : 1 } },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: loading || saving,
            onChange: event => setEnabled(event.target.checked),
          }),
          h('span', null, '启用记录（关闭后不再写新记录，已有文件不动）'),
        ),
        notice === '' ? null : h('div', { style: hint, role: 'status' }, notice),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-work-log',
          order: 10,
        }, Panel))
      },
    }
  },
})
