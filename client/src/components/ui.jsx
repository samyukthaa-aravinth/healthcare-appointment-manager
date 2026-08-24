import { Link } from 'react-router-dom';
import { timeOf, dateOf } from '../lib/format.js';

export const Alert = ({ kind = 'info', title, children, onDismiss }) => (
  <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    <div className="spread">
      <div>
        {title && <strong>{title}</strong>}
        {title && children ? <div style={{ marginTop: 4 }}>{children}</div> : children}
      </div>
      {onDismiss && (
        <button className="btn ghost small" onClick={onDismiss} type="button">
          Dismiss
        </button>
      )}
    </div>
  </div>
);

/** Renders an ApiError, including field-level validation details. */
export const ErrorNote = ({ error, onDismiss }) => {
  if (!error) return null;
  return (
    <Alert kind="error" onDismiss={onDismiss}>
      {error.message}
      {Array.isArray(error.details) && error.details.length > 0 && (
        <ul>
          {error.details.map((d, i) => (
            <li key={i}>
              {d.field}: {d.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
};

export const Field = ({ label, hint, children, ...rest }) => (
  <label className="field">
    <span>
      {label} {hint && <em className="hint">{hint}</em>}
    </span>
    {children || <input {...rest} />}
  </label>
);

export const Badge = ({ tone = 'neutral', children }) => <span className={`badge ${tone}`}>{children}</span>;

export const UrgencyBadge = ({ urgency, llmStatus }) => {
  if (!urgency) return <Badge>Triage pending</Badge>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <Badge tone={urgency}>{urgency}</Badge>
      {llmStatus === 'FALLBACK' && <Badge>Keyword triage</Badge>}
    </span>
  );
};

export const Empty = ({ title, children, action }) => (
  <div className="empty">
    <h3>{title}</h3>
    {children && <p className="tight">{children}</p>}
    {action && <div style={{ marginTop: 14 }}>{action}</div>}
  </div>
);

export const Loading = ({ rows = 3 }) => (
  <div className="stack" aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div className="skeleton" key={i} />
    ))}
  </div>
);

export const Stat = ({ label, value }) => (
  <div className="stat">
    <span className="n">{value}</span>
    <span className="k">{label}</span>
  </div>
);

const STATUS_TONE = { CONFIRMED: 'teal', HELD: 'MEDIUM', COMPLETED: 'neutral', CANCELLED: 'neutral' };

/**
 * The appointment card. The left spine carries urgency, which is the whole
 * point of the pre-visit triage — a doctor scanning a day should see the
 * HIGH ones without reading a word.
 */
export const AppointmentCard = ({ appointment: a, to, perspective = 'PATIENT', footer }) => {
  const urgency = a.symptomReport?.urgency;
  const cancelled = a.status === 'CANCELLED';
  const who =
    perspective === 'DOCTOR' ? a.patient?.fullName || 'Patient' : `Dr ${a.doctor?.fullName || ''}`.trim();

  const inner = (
    <>
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="appt-when">
            {dateOf(a.startsAt)} · {timeOf(a.startsAt)}
          </div>
          <p className="appt-who">{who}</p>
          <p className="appt-meta">
            {perspective === 'DOCTOR'
              ? a.symptomReport?.chiefComplaint || a.reasonText || 'No symptom summary yet'
              : a.doctor?.specialisation}
          </p>
        </div>
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {urgency && <Badge tone={urgency}>{urgency}</Badge>}
          <Badge tone={STATUS_TONE[a.status] || 'neutral'}>{a.status}</Badge>
        </div>
      </div>
      {footer}
    </>
  );

  const className = `appt u-${urgency || 'NONE'} ${cancelled ? 'cancelled' : ''} ${to ? 'is-link' : ''}`;

  return to ? (
    <Link to={to} className={className} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
};
