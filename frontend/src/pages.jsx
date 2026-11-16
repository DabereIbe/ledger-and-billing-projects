import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api.js';
import { useAuth } from './auth.jsx';

const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
const date = (d) => (d ? new Date(d).toLocaleDateString() : '—');
const BADGE = { active: 'badge-success', pending: 'badge-warning', past_due: 'badge-error', canceled: 'badge-ghost' };
const Status = ({ s }) => <span className={`badge ${BADGE[s] ?? ''}`}>{s}</span>;
const Err = ({ msg }) => msg && <div role="alert" className="alert alert-error my-3"><span>{msg}</span></div>;
const Loading = () => <span className="loading loading-spinner" />;
const Page = ({ title, children }) => <><h1 className="text-2xl font-bold mb-4">{title}</h1>{children}</>;

export function Nav() {
  const { user, logout } = useAuth();
  return (
    <nav className="navbar bg-base-100 shadow-sm px-6">
      <Link to="/" className="flex-1 text-xl font-bold">Billing</Link>
      {user
        ? <div className="flex items-center gap-3 text-sm">{user.email} <span className="badge badge-outline">{user.role}</span>
            <button className="btn btn-sm" onClick={logout}>Log out</button></div>
        : <div className="flex gap-2"><Link className="btn btn-sm btn-ghost" to="/login">Log in</Link>
            <Link className="btn btn-sm btn-primary" to="/register">Start a business</Link></div>}
    </nav>
  );
}

export function Home() {
  const { user } = useAuth();
  if (user === undefined) return <Loading />;
  if (user === null) return <Navigate to="/login" />;
  return user.role === 'owner' ? <Owner user={user} /> : <Customer />;
}

export function Login() {
  const { login } = useAuth(); const nav = useNavigate(); const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await login(f.get('email'), f.get('password')); nav('/'); } catch (x) { setErr(x.message); }
  };
  return (
    <Page title="Log in">
      <form onSubmit={submit} className="card bg-base-100 shadow p-6 max-w-sm gap-3">
        <input className="input w-full" name="email" type="email" placeholder="Email" required />
        <input className="input w-full" name="password" type="password" placeholder="Password" required />
        <button className="btn btn-primary">Log in</button><Err msg={err} />
      </form>
    </Page>
  );
}

// /register = business owner. /join/:businessId = customer invite link.
export function Register() {
  const { businessId } = useParams(); const nav = useNavigate();
  const [biz, setBiz] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { if (businessId) api(`/businesses/${businessId}`).then(setBiz).catch(() => setErr('This invite link is invalid.')); }, [businessId]);
  const submit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const body = { email: f.get('email'), password: f.get('password'), role: businessId ? 'customer' : 'owner',
      ...(businessId ? { businessId } : { businessName: f.get('businessName') }) };
    try { await api('/auth/register', { method: 'POST', body }); nav('/login'); } catch (x) { setErr(x.message); }
  };
  if (businessId && !biz) return err ? <Err msg={err} /> : <Loading />;
  return (
    <Page title={biz ? `Join ${biz.name}` : 'Start a business'}>
      <form onSubmit={submit} className="card bg-base-100 shadow p-6 max-w-sm gap-3">
        {!biz && <input className="input w-full" name="businessName" placeholder="Business name" required minLength={2} />}
        <input className="input w-full" name="email" type="email" placeholder="Email" required />
        <input className="input w-full" name="password" type="password" placeholder="Password (10+ chars)" required minLength={10} />
        <button className="btn btn-primary">Create account</button><Err msg={err} />
      </form>
    </Page>
  );
}

function Owner({ user }) {
  const [sum, setSum] = useState(); const [plans, setPlans] = useState([]); const [subs, setSubs] = useState([]); const [err, setErr] = useState('');
  const load = () => Promise.all([api('/businesses/me/summary'), api('/plans'), api('/subscriptions')])
    .then(([s, p, b]) => { setSum(s); setPlans(p); setSubs(b); }).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, []);
  const addPlan = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      await api('/plans', { method: 'POST', body: { name: f.get('name'), amountKobo: Math.round(Number(f.get('naira')) * 100), interval: f.get('interval') } });
      e.target.reset(); setErr(''); load();
    } catch (x) { setErr(x.message); }
  };
  return (
    <Page title={sum?.name ?? user.businessName}>
      <Err msg={err} />
      {sum && <div className="stats shadow w-full bg-base-100 mb-4">
        <div className="stat"><div className="stat-title">Revenue (from ledger)</div>
          <div className="stat-value text-2xl">{sum.ledgerAvailable ? naira(sum.revenueKobo) : 'Unavailable'}</div></div>
        <div className="stat"><div className="stat-title">Active</div><div className="stat-value">{sum.subscriptions.active}</div></div>
        <div className="stat"><div className="stat-title">Past due</div><div className="stat-value">{sum.subscriptions.past_due}</div></div>
        <div className="stat"><div className="stat-title">Pending</div><div className="stat-value">{sum.subscriptions.pending}</div></div>
      </div>}
      <p className="mb-6 text-sm">Customer invite link: <code className="kbd kbd-sm">{`${location.origin}/join/${user.businessId}`}</code></p>
      <h2 className="text-lg font-semibold mb-2">Plans</h2>
      <ul className="mb-3">{plans.map((p) => <li key={p._id}>{p.name}: {naira(p.amountKobo)} / {p.interval}</li>)}</ul>
      <form onSubmit={addPlan} className="flex flex-wrap gap-2 mb-8">
        <input className="input" name="name" placeholder="Plan name" required />
        <input className="input w-36" name="naira" type="number" min="1" step="0.01" placeholder="Price (₦)" required />
        <select className="select w-36" name="interval"><option value="monthly">monthly</option><option value="annually">annually</option></select>
        <button className="btn btn-primary">Add plan</button>
      </form>
      <h2 className="text-lg font-semibold mb-2">Subscriptions</h2>
      <div className="overflow-x-auto bg-base-100 shadow rounded-box">
        <table className="table table-zebra"><thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>Renews</th></tr></thead>
          <tbody>{subs.map((s) => <tr key={s._id}><td>{s.customerEmail}</td><td>{plans.find((p) => p._id === s.planId)?.name ?? '—'}</td><td><Status s={s.status} /></td><td>{date(s.currentPeriodEnd)}</td></tr>)}</tbody></table>
      </div>
    </Page>
  );
}

function Customer() {
  const [plans, setPlans] = useState([]); const [subs, setSubs] = useState([]); const [err, setErr] = useState('');
  useEffect(() => { Promise.all([api('/plans'), api('/subscriptions/mine')]).then(([p, s]) => { setPlans(p); setSubs(s); }).catch((x) => setErr(x.message)); }, []);
  const subscribe = async (planId) => {
    try { window.location.assign((await api('/subscriptions', { method: 'POST', body: { planId } })).checkoutUrl); }   // off to Paystack
    catch (x) { setErr(x.message); }
  };
  return (
    <Page title="Plans">
      <Err msg={err} />
      <div className="grid gap-3 sm:grid-cols-2 mb-8">
        {plans.map((p) => (
          <div className="card bg-base-100 shadow" key={p._id}><div className="card-body">
            <h3 className="card-title">{p.name}</h3><p>{naira(p.amountKobo)} / {p.interval}</p>
            <div className="card-actions justify-end"><button className="btn btn-primary" onClick={() => subscribe(p._id)}>Subscribe</button></div>
          </div></div>
        ))}
      </div>
      <h2 className="text-lg font-semibold mb-2">My subscriptions</h2>
      <div className="overflow-x-auto bg-base-100 shadow rounded-box">
        <table className="table table-zebra"><thead><tr><th>Plan</th><th>Status</th><th>Renews</th></tr></thead>
          <tbody>{subs.map((s) => <tr key={s._id}><td>{plans.find((p) => p._id === s.planId)?.name ?? '—'}</td><td><Status s={s.status} /></td><td>{date(s.currentPeriodEnd)}</td></tr>)}</tbody></table>
      </div>
    </Page>
  );
}

// Paystack redirects here with ?reference=. The redirect proves nothing; only the signed webhook activates
// the subscription, so we poll the API until it does (or give up and say so honestly).
export function Callback() {
  const { user } = useAuth(); const [q] = useSearchParams();
  const ref = q.get('reference') || q.get('trxref');
  const [s, setS] = useState(null); const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!ref || !user) return;
    let stop = false; const start = Date.now();
    (async function poll() {
      try { const r = await api(`/subscriptions/by-reference/${encodeURIComponent(ref)}`); if (stop) return; setS(r); if (r.status === 'active') return; } catch { /* retry */ }
      if (stop) return;
      if (Date.now() - start > 90_000) return setGaveUp(true);
      setTimeout(poll, 2000);
    })();
    return () => { stop = true; };
  }, [ref, user]);
  if (!ref) return <p>No payment reference found.</p>;
  if (user === undefined) return <Loading />;
  if (!user) return <p>Please <Link className="link" to="/login">log in</Link> to see your payment status.</p>;
  const back = <Link className="btn btn-primary mt-4" to="/">Back to plans</Link>;
  if (s?.status === 'active') return <Page title="Payment confirmed ✓"><p>Active until {date(s.currentPeriodEnd)}.</p>{back}</Page>;
  if (gaveUp) return <Page title="Still processing"><p>We haven’t received confirmation yet. Check “My subscriptions” shortly.</p>{back}</Page>;
  return <Page title="Confirming your payment…"><Loading /> <span className="ml-2">This usually takes a few seconds.</span></Page>;
}
