// Shared by the server and the web app.
export const CITIES = ['Chennai', 'Bengaluru', 'Hyderabad', 'Mumbai', 'Delhi', 'Kolkata', 'Pune', 'Kochi'];
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
export const CARD_TYPE = 'RS:Request';

export const roomId = (city) => 'rs_' + city.toLowerCase().replace(/[^a-z]/g, '');

// Who can give to whom (red cells).
const DONORS_FOR = {
  'O-': ['O-'],
  'O+': ['O+', 'O-'],
  'A-': ['A-', 'O-'],
  'A+': ['A+', 'A-', 'O+', 'O-'],
  'B-': ['B-', 'O-'],
  'B+': ['B+', 'B-', 'O+', 'O-'],
  'AB-': ['AB-', 'A-', 'B-', 'O-'],
  'AB+': ['AB+', 'AB-', 'A+', 'A-', 'B+', 'B-', 'O+', 'O-'],
};
export const canGive = (donor, patient) => Boolean(donor && patient && DONORS_FOR[patient]?.includes(donor));

export function liveStatus(m, now = Date.now()) {
  const units = Number(m.units || 1);
  const arranged = Math.min(units, Number(m.arranged || 0));
  const pledged = Number(m.pledged || 0);
  if (m.status === 'fulfilled') return { state: 'fulfilled', label: 'Fulfilled', line: `Fulfilled · please don't call`, units, arranged: units, pledged };
  if (m.status === 'cancelled') return { state: 'closed', label: 'Closed', line: 'Closed by the family', units, arranged, pledged };
  if (Number(m.neededBy || 0) < now) return { state: 'expired', label: 'Expired', line: 'Expired · no longer active', units, arranged, pledged };
  return { state: 'open', label: 'Needed now', line: `${arranged} of ${units} unit${units > 1 ? 's' : ''} arranged`, units, arranged, pledged };
}

export function publicView(m) {
  const s = liveStatus(m);
  return {
    bg: m.bg,
    units: s.units,
    arranged: s.arranged,
    pledged: s.pledged,
    hospital: m.hospital,
    city: m.city,
    neededBy: Number(m.neededBy || 0),
    createdAt: Number(m.createdAt || 0),
    updatedAt: Number(m.updatedAt || m.createdAt || 0),
    closedAt: Number(m.closedAt || 0) || null,
    ownerName: m.ownerName,
    state: s.state,
    label: s.label,
    statusLine: s.line,
  };
}

export function timeLeft(ts, now = Date.now()) {
  const d = ts - now;
  const a = Math.abs(d);
  const h = Math.floor(a / 3600000);
  const mi = Math.round((a % 3600000) / 60000);
  const txt = h ? `${h}h ${mi}m` : `${mi}m`;
  return d >= 0 ? `${txt} left` : `${txt} ago`;
}

export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// Paid blood donation is banned in India (since 1 Jan 1998). Any money ask in a donor chat is a red flag.
export const MONEY_RE = /(\bupi\b|g ?pay|phone ?pe|paytm|\bpay\b|payment|transfer|send (?:me )?(?:rs|₹|money)|₹\s?\d|\brs\.?\s?\d|rupees|convenience fee|travel (?:fee|charge|cost)|advance|qr code|bank account|\bifsc\b)/i;
