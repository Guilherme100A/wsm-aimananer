// T20 — diálogo "Adicionar número": escolhe UMA sessão do sistema, pede confirmação e mostra o resultado.
import { useState } from 'react'
import type { Session } from '../lib/types'
import {
  confirmText,
  groupsAddApi,
  resultFromError,
  resultText,
  sessionLabel,
  targetOptions,
  type GroupAddResult,
  type GroupWithAdmin,
} from '../pages/Groups.logic'

export interface GroupAddDialogProps {
  adminSessionId: string
  group: GroupWithAdmin
  sessions: Session[]
  onClose: () => void
  /** Chamado depois de uma adição bem-sucedida (para recarregar a lista). */
  onAdded?: () => void
}

export function GroupAddDialog({ adminSessionId, group, sessions, onClose, onAdded }: GroupAddDialogProps) {
  const options = targetOptions(sessions, adminSessionId)
  const [targetId, setTargetId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GroupAddResult>()
  const target = options.find((s) => s.id === targetId)

  async function confirm() {
    if (!target) return
    setBusy(true)
    try {
      const res = await groupsAddApi.add(adminSessionId, group.id, target.id)
      setResult(res.result)
      if (res.result === 'added') onAdded?.()
    } catch (err) {
      setResult(resultFromError(err))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="group-add-title" data-testid="group-add-dialog">
      <h2 id="group-add-title">Adicionar número ao grupo {group.name || group.id}</h2>
      <p className="hint">Adiciona uma sessão do sistema a este grupo. Uma por vez, com confirmação.</p>
      <label htmlFor="group-add-target">Sessão</label>
      <select
        id="group-add-target"
        data-testid="group-add-target"
        value={targetId}
        disabled={busy}
        onChange={(e) => {
          setTargetId(e.target.value)
          setConfirming(false)
          setResult(undefined)
        }}
      >
        <option value="">Selecione…</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {sessionLabel(s)}
          </option>
        ))}
      </select>

      {!confirming ? (
        <div className="row">
          <button type="button" data-testid="group-add-confirm-step" disabled={!target || busy} onClick={() => setConfirming(true)}>
            Continuar
          </button>
          <button type="button" data-testid="group-add-cancel" onClick={onClose}>
            {result ? 'Fechar' : 'Cancelar'}
          </button>
        </div>
      ) : (
        <div className="confirm">
          <p data-testid="group-add-confirm-text">{target ? confirmText(target, group) : ''}</p>
          <div className="row">
            <button type="button" data-testid="group-add-confirm" disabled={busy} onClick={() => void confirm()}>
              Adicionar
            </button>
            <button type="button" data-testid="group-add-cancel" disabled={busy} onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {result ? (
        <p className={result === 'added' || result === 'already_member' ? 'status' : 'error'} role="status" data-testid="group-add-result" data-result={result}>
          {resultText(result)}
        </p>
      ) : null}
    </div>
  )
}
