import type { JoinRequest } from '../lib/joinRequest.js'

interface Props {
  requests: JoinRequest[]
  onAccept: (eventId: string) => void
  onReject: (eventId: string) => void
}

export function JoinRequestView({ requests, onAccept, onReject }: Props) {
  const pending = requests.filter(r => r.status === 'pending')

  if (pending.length === 0) return null

  return (
    <div className="card border-0 shadow-sm mb-3">
      <div className="card-body p-3">
        <h6 className="card-title mb-2" style={{ color: '#C9A96E' }}>
          Pending connection requests
        </h6>
        <ul className="list-group list-group-flush">
          {pending.map(req => (
            <li key={req.eventId} className="list-group-item px-0 py-2">
              <div className="d-flex align-items-center gap-2">
                <div
                  className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0 text-white fw-bold"
                  style={{ width: 36, height: 36, background: '#C9A96E', fontSize: 14 }}
                >
                  {req.displayName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-grow-1 min-width-0">
                  <div className="fw-semibold small">{req.displayName}</div>
                  <div className="text-muted font-monospace" style={{ fontSize: 11 }}>
                    {req.requesterNpub.slice(0, 20)}…
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-success py-0 px-2"
                  onClick={() => onAccept(req.eventId)}
                >
                  Accept
                </button>
                <button
                  className="btn btn-sm btn-outline-secondary py-0 px-2"
                  onClick={() => onReject(req.eventId)}
                >
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
