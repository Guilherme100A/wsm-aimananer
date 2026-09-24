// IA / Modelo LLM (T19): chave de API (só o estado: configurada ou não), modelos, limiar, tokens, timeout,
// ativar/desativar e teste de conexão. A IA só sugere respostas para mensagens recebidas; nada é enviado sem aprovação.
import { useEffect, useState, type FormEvent } from 'react'
import { ErrorText } from '../components/ui'
import {
  aiApi,
  AI_LIMITS,
  formFromSettings,
  keyStatusLabel,
  payloadFromForm,
  sourceLabel,
  testResultText,
  type AiForm,
  type AiSettings,
  type AiSettingsField,
  type AiTestResult,
} from './AiSettings.logic'

function Source({ settings, field }: { settings: AiSettings; field: AiSettingsField }) {
  const s = settings.sources[field]
  return (
    <span className="source" data-testid={`ai-source-${field}`} title={s === 'db' ? 'definido no painel' : 'variável de ambiente ou padrão'}>
      {sourceLabel(s)}
    </span>
  )
}

export function AiSettingsPage() {
  const [settings, setSettings] = useState<AiSettings>()
  const [form, setForm] = useState<AiForm>()
  const [error, setError] = useState<unknown>()
  const [replacing, setReplacing] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [status, setStatus] = useState<string>()
  const [testResult, setTestResult] = useState<AiTestResult>()
  const [busy, setBusy] = useState(false)

  function apply(s: AiSettings) {
    setSettings(s)
    setForm(formFromSettings(s))
  }

  useEffect(() => {
    aiApi.get().then(apply, setError)
  }, [])

  async function run(fn: () => Promise<void>) {
    setError(undefined)
    setStatus(undefined)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!settings || !form) return
    void run(async () => {
      const payload = payloadFromForm(form, settings)
      if (Object.keys(payload).length === 0) {
        setStatus('Nada para salvar.')
        return
      }
      apply(await aiApi.update(payload))
      setStatus('Configurações salvas. O worker aplica em alguns segundos, sem reiniciar.')
    })
  }

  const saveKey = () =>
    run(async () => {
      if (!newKey.trim()) throw new Error('Informe a nova chave.')
      apply(await aiApi.update({ apiKey: newKey.trim() }))
      setNewKey('')
      setReplacing(false)
      setStatus('Chave salva (cifrada).')
    })

  const removeKey = () =>
    run(async () => {
      apply(await aiApi.update({ apiKey: null }))
      setStatus('Chave removida do painel.')
    })

  const test = () =>
    run(async () => {
      setTestResult(undefined)
      // Testa com os valores do formulário (sem salvar); a chave é a salva, ou a digitada em "substituir".
      const override = settings && form ? payloadFromForm(form, settings) : {}
      if (replacing && newKey.trim()) override.apiKey = newKey.trim()
      setTestResult(await aiApi.test(override))
    })

  const set = <K extends keyof AiForm>(k: K, v: AiForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  return (
    <div data-testid="page-ai">
      <h1>IA / Modelo LLM</h1>
      <p className="hint">
        A IA assistiva só sugere respostas para mensagens recebidas; toda sugestão passa por aprovação humana antes do envio.
      </p>
      <ErrorText error={error} testId="ai-error" />
      {status ? (
        <p className="status" data-testid="ai-status">
          {status}
        </p>
      ) : null}
      {!settings || !form ? (
        <p>Carregando…</p>
      ) : (
        <>
          <section className="panel" data-testid="ai-key">
            <h2>Chave de API ({settings.provider})</h2>
            <p>
              Chave: <strong data-testid="ai-key-status">{keyStatusLabel(settings.hasApiKey)}</strong> <Source settings={settings} field="apiKey" />
            </p>
            {replacing ? (
              <div className="row">
                <label htmlFor="ai-key-input">Nova chave</label>
                <input
                  id="ai-key-input"
                  data-testid="ai-key-input"
                  type="password"
                  autoComplete="off"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                />
                <button type="button" data-testid="ai-key-save" disabled={busy} onClick={() => void saveKey()}>
                  Salvar chave
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReplacing(false)
                    setNewKey('')
                  }}
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <div className="row">
                <button type="button" data-testid="ai-key-replace" onClick={() => setReplacing(true)}>
                  Substituir
                </button>
                <button type="button" data-testid="ai-key-remove" disabled={busy || settings.sources.apiKey !== 'db'} onClick={() => void removeKey()}>
                  Remover
                </button>
              </div>
            )}
          </section>

          {/* noValidate: a validação (com mensagem em ai-error) é a do formulário, não a nativa do navegador. */}
          <form className="panel form" noValidate onSubmit={save}>
            <h2>Modelo</h2>
            <label htmlFor="ai-model-small">
              Modelo pequeno (padrão) <Source settings={settings} field="modelSmall" />
            </label>
            <input id="ai-model-small" data-testid="ai-model-small" value={form.modelSmall} onChange={(e) => set('modelSmall', e.target.value)} />

            <label htmlFor="ai-model-large">
              Modelo grande (baixa confiança) <Source settings={settings} field="modelLarge" />
            </label>
            <input id="ai-model-large" data-testid="ai-model-large" value={form.modelLarge} onChange={(e) => set('modelLarge', e.target.value)} />

            <label htmlFor="ai-threshold">
              Limiar de confiança (0–1) <Source settings={settings} field="confidenceThreshold" />
            </label>
            <input
              id="ai-threshold"
              data-testid="ai-threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.confidenceThreshold}
              onChange={(e) => set('confidenceThreshold', e.target.value)}
            />

            <label htmlFor="ai-max-tokens">
              Limite de tokens <Source settings={settings} field="maxTokens" />
            </label>
            <input
              id="ai-max-tokens"
              data-testid="ai-max-tokens"
              type="number"
              min={AI_LIMITS.maxTokens.min}
              max={AI_LIMITS.maxTokens.max}
              step={1}
              value={form.maxTokens}
              onChange={(e) => set('maxTokens', e.target.value)}
            />

            <label htmlFor="ai-timeout">
              Timeout (ms) <Source settings={settings} field="timeoutMs" />
            </label>
            <input
              id="ai-timeout"
              data-testid="ai-timeout"
              type="number"
              min={AI_LIMITS.timeoutMs.min}
              max={AI_LIMITS.timeoutMs.max}
              step={100}
              value={form.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value)}
            />

            <label className="check">
              <input type="checkbox" data-testid="ai-enabled" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> IA ativada{' '}
              <Source settings={settings} field="enabled" />
            </label>

            <div className="row">
              <button type="submit" data-testid="ai-save" disabled={busy}>
                Salvar
              </button>
              <button type="button" data-testid="ai-test" disabled={busy} onClick={() => void test()}>
                Testar conexão
              </button>
            </div>
          </form>

          {testResult ? (
            <p className={testResult.ok ? 'status' : 'error'} data-testid="ai-test-result" data-ok={String(testResult.ok)}>
              {testResultText(testResult)}
            </p>
          ) : null}
          {settings.updatedAt ? <p className="hint">Atualizado em {new Date(settings.updatedAt).toLocaleString()}</p> : null}
        </>
      )}
    </div>
  )
}
