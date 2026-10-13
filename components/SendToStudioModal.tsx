import React, { useEffect, useMemo, useRef, useState } from 'react';
import { catalogSupabase } from '../services/supabase';
import type { DAWState } from '../types';
import {
  STUDIO_SERVICES, STUDIO_SLOTS, buildStudioNotes, checkBooking, dayLabel, defaultBookingDate, estimateStemsBytes,
  noteLine, serviceLabel, sizeLabel, slotLabel, type BookingInput,
} from '../utils/studioPackage';
import { buildStudioFiles, newSendState, sendStudioPackage, StudioSendError, type StudioBooking, type StudioFile } from '../services/StudioSend';
import { isStemSource } from '../utils/stemPlan';

/**
 * « Envoyer au studio » (chantier 17 · B6) : le projet, les stems, les notes
 * horodatées et une demande de réservation, en un seul envoi au studio Make
 * Music. Une page : ce qu'on envoie → quand venir → envoyer → reçu (référence).
 */

export interface SendToStudioModalProps {
  open: boolean;
  onClose: () => void;
  state: DAWState;
  owned: (string | number)[];
  signedIn: boolean;
  defaultName: string;
  onLogin: () => void;
  sampleRate: number;
}

type Phase = { k: 'form' } | { k: 'sending'; pct: number; text: string } | { k: 'done'; booking: StudioBooking; files: number; bytes: number } | { k: 'error'; text: string; retry: boolean };

const SendToStudioModal: React.FC<SendToStudioModalProps> = (p) => {
  const [stems, setStems] = useState(true);
  const [notes, setNotes] = useState(true);
  const [service, setService] = useState<BookingInput['service']>('enregistrement');
  const [date, setDate] = useState(defaultBookingDate());
  const [slot, setSlot] = useState<BookingInput['slot']>('flexible');
  const [hours, setHours] = useState(2);
  const [name, setName] = useState(p.defaultName);
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>({ k: 'form' });
  const sendState = useRef(newSendState());
  const built = useRef<{ key: string; files: StudioFile[] } | null>(null);
  const busy = useRef(false);
  // Compte Make Music (celui de la collaboration et des fonctions serveur) : vérifié à l'ouverture.
  const [account, setAccount] = useState<{ email: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!p.open) return;
    let gone = false;
    catalogSupabase.auth.getSession().then(({ data }) => {
      if (gone) return;
      const em = data?.session?.user?.email || '';
      setAccount(data?.session ? { email: em } : null);
      if (data?.session && !name.trim()) setName(em.split('@')[0] || '');
    }).catch(() => { if (!gone) setAccount(null); });
    return () => { gone = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open]);
  const signedIn = account === undefined ? p.signedIn : !!account || p.signedIn;

  const n = useMemo(() => buildStudioNotes(p.state as any), [p.state]);
  const stemCount = p.state.tracks.filter(t => isStemSource(t)).length;
  const seconds = Math.max(1, ...p.state.tracks.filter(t => !t.isGuide).flatMap(t => t.clips.map(c => c.start + c.duration)));
  const stemsBytes = estimateStemsBytes(stemCount, seconds, p.sampleRate);
  const today = defaultBookingDate(new Date(Date.now() - 3 * 86400000));

  if (!p.open) return null;

  const booking = (): BookingInput => ({ service, date, slot, hours, name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), ...(message.trim() ? { message: message.trim() } : {}) });

  const send = async () => {
    if (busy.current) return; // double clic : un seul envoi
    const b = checkBooking(booking());
    if (b.ok === false) { setErrors((b as { errors: Record<string, string> }).errors); return; }
    const value = (b as { value: BookingInput }).value;
    setErrors({});
    busy.current = true;
    setPhase({ k: 'sending', pct: 1, text: 'Préparation…' });
    const onP = (pct: number, text: string) => setPhase({ k: 'sending', pct: Math.max(1, Math.min(99, pct)), text });
    try {
      // Les fichiers ne sont fabriqués qu'une fois : « Réessayer » reprend le même paquet.
      const key = `${stems}|${notes}|${service}|${date}|${slot}|${hours}|${name}|${phone}|${message}`;
      if (!built.current || (!sendState.current.packageId && built.current.key !== key)) {
        built.current = { key, files: await buildStudioFiles(p.state, { stems, notes, owned: p.owned, booking: value }, onP) };
      }
      const files = built.current.files;
      const r = await sendStudioPackage(files, { title: p.state.name || 'Projet', bpm: p.state.bpm, key: (p.state as any).projectKey ?? null, notesCount: n.timed }, value, sendState.current, onP);
      setPhase({ k: 'done', booking: r.booking, files: files.length, bytes: files.reduce((x, f) => x + f.blob.size, 0) });
    } catch (e) {
      const err = e as StudioSendError;
      if (err.code === 'booking' && err.extra?.errors) { setErrors(err.extra.errors); setPhase({ k: 'form' }); return; }
      const started = !!sendState.current.packageId;
      const text = err.code === 'login' ? 'Connecte-toi à ton compte Make Music pour envoyer au studio.'
        : err.code === 'network' || err.code === 'upload'
          ? `L'envoi s'est coupé${started ? ` (${sendState.current.done.size} fichier(s) déjà au studio)` : ''}. Vérifie ton réseau, puis « Réessayer » : on reprend où ça s'est arrêté.`
          : err.message || "L'envoi n'a pas abouti.";
      setPhase({ k: 'error', text, retry: err.code !== 'not_deployed' && err.code !== 'login' && err.code !== 'daily_limit' });
    } finally { busy.current = false; }
  };

  const field = 'w-full min-h-12 rounded-xl border border-white/10 bg-black/40 px-3 text-[15px] text-white';
  const chip = (on: boolean) => `min-h-12 rounded-xl px-3 text-[14px] font-bold ${on ? 'bg-white text-black' : 'bg-white/10 text-slate-100'}`;
  const err = (k: string) => errors[k] && <p role="alert" data-testid={`studio-err-${k}`} className="text-[13px] font-semibold text-red-300">{errors[k]}</p>;
  const sending = phase.k === 'sending';
  const timedNotes = n.notes.filter(x => x.t !== null);

  return (
    <div className="fixed inset-0 z-[600] flex items-end justify-center bg-black/70 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="studio-send-t" data-testid="studio-send"
      onKeyDown={e => { if (e.key === 'Escape' && !sending) { e.stopPropagation(); p.onClose(); } }}>
      <div className="flex max-h-[100dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-nv-surface text-white sm:max-h-[92vh] sm:rounded-3xl">
        <header className="flex shrink-0 items-start gap-3 border-b border-white/10 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="studio-send-t" className="text-[19px] font-black">🏠 Envoyer au studio Make Music</h2>
            <p className="text-[13px] text-slate-400">Ton projet arrive chez l'ingé avec tes notes, et tu demandes ton créneau en même temps.</p>
          </div>
          <button type="button" onClick={p.onClose} disabled={sending} aria-label="Fermer" className="h-11 w-11 shrink-0 rounded-xl bg-white/10 text-[16px] font-black disabled:opacity-40">✕</button>
        </header>

        {phase.k === 'done' ? (
          <div className="space-y-4 overflow-y-auto px-5 py-6" data-testid="studio-done">
            <p className="text-[44px] leading-none">✅</p>
            <h3 className="text-[20px] font-black">Reçu par le studio</h3>
            <p className="text-[15px] text-slate-200">{phase.files} fichiers ({sizeLabel(phase.bytes)}) sont arrivés chez Make Music, avec ta demande :</p>
            <div className="rounded-2xl bg-white/[0.06] p-4 text-[15px]">
              <p className="font-black">{serviceLabel(phase.booking.service)}</p>
              <p>{(d => d.charAt(0).toUpperCase() + d.slice(1))(dayLabel(phase.booking.date))} · {slotLabel(phase.booking.slot).toLowerCase()} · {phase.booking.hours} h</p>
              <p className="mt-2 text-[13px] text-slate-400">Référence <b data-testid="studio-ref" className="text-amber-200">{phase.booking.reference}</b> (à donner si tu appelles le studio)</p>
            </div>
            <p className="text-[13px] text-slate-300">C'est une <b>demande</b> : le studio te confirme le créneau. Rien n'est payé maintenant.</p>
            <button type="button" onClick={p.onClose} className="min-h-12 w-full rounded-2xl bg-cyan-500 text-[15px] font-black text-black">Fermer</button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {!signedIn && (
                <div role="alert" data-testid="studio-login" className="flex items-center gap-3 rounded-2xl bg-amber-500/15 p-3 text-[14px] text-amber-50">
                  <span className="min-w-0 flex-1">Connecte-toi à ton compte Make Music : le studio doit savoir qui envoie.</span>
                  <button type="button" onClick={p.onLogin} className="h-11 shrink-0 rounded-xl bg-white px-3 text-[13px] font-black text-black">Me connecter</button>
                </div>
              )}

              <section className="space-y-2" aria-labelledby="studio-what">
                <h3 id="studio-what" className="text-[15px] font-black">1. Ce que tu envoies</h3>
                <p className="flex min-h-12 items-center gap-3 rounded-xl bg-white/[0.04] px-3 text-[14px]"><span aria-hidden>📦</span><span className="flex-1"><b>Le projet complet</b> : toutes les pistes, les effets, les réglages</span><span className="text-emerald-300">✓</span></p>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl bg-white/[0.04] px-3 text-[14px]">
                  <input type="checkbox" data-testid="studio-stems" checked={stems} onChange={e => setStems(e.target.checked)} disabled={sending} className="h-5 w-5 accent-cyan-400" />
                  <span className="flex-1"><b>Les stems</b> : {stemCount} piste{stemCount > 1 ? 's' : ''} séparée{stemCount > 1 ? 's' : ''}, qualité studio <span className="text-slate-400">(≈ {sizeLabel(stemsBytes)})</span></span>
                </label>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl bg-white/[0.04] px-3 text-[14px]">
                  <input type="checkbox" data-testid="studio-notes" checked={notes} onChange={e => setNotes(e.target.checked)} disabled={sending} className="h-5 w-5 accent-cyan-400" />
                  <span className="flex-1"><b>Tes notes</b> : {timedNotes.length ? `${timedNotes.length} au bon moment du morceau` : 'aucune note horodatée'}{n.notes.length > timedNotes.length ? ', + notes de séance et paroles' : ''}</span>
                </label>
                {notes && timedNotes.length > 0 && (
                  <ul data-testid="studio-notes-preview" className="space-y-1 rounded-xl bg-black/30 p-3 text-[13px] text-slate-300">
                    {timedNotes.slice(0, 4).map((x, i) => <li key={i} className="truncate">{noteLine(x)}</li>)}
                    {timedNotes.length > 4 && <li className="text-slate-500">… et {timedNotes.length - 4} autres</li>}
                  </ul>
                )}
              </section>

              <section className="space-y-3" aria-labelledby="studio-when">
                <h3 id="studio-when" className="text-[15px] font-black">2. Ta demande de réservation</h3>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Ce que tu veux faire">
                  {STUDIO_SERVICES.map(s => (
                    <button key={s.id} type="button" role="radio" aria-checked={service === s.id} data-testid={`studio-service-${s.id}`} disabled={sending} onClick={() => setService(s.id)} className={chip(service === s.id)}>{s.label}</button>
                  ))}
                </div>
                {err('service')}
                <label className="block space-y-1">
                  <span className="text-[13px] font-bold text-slate-300">Jour souhaité</span>
                  <input type="date" data-testid="studio-date" value={date} min={today} onChange={e => setDate(e.target.value)} disabled={sending} className={field} />
                </label>
                {err('date')}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Moment de la journée">
                  {STUDIO_SLOTS.map(s => (
                    <button key={s.id} type="button" role="radio" aria-checked={slot === s.id} data-testid={`studio-slot-${s.id}`} disabled={sending} onClick={() => setSlot(s.id)} className={chip(slot === s.id)}>{s.label}</button>
                  ))}
                </div>
                {err('slot')}
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-[14px] font-bold text-slate-300">Durée</span>
                  <button type="button" aria-label="Une heure de moins" disabled={sending || hours <= 1} onClick={() => setHours(h => Math.max(1, h - 1))} className="h-12 w-12 rounded-xl bg-white/10 text-[20px] font-black disabled:opacity-40">−</button>
                  <span data-testid="studio-hours" className="w-16 text-center text-[18px] font-black">{hours} h</span>
                  <button type="button" aria-label="Une heure de plus" disabled={sending || hours >= 12} onClick={() => setHours(h => Math.min(12, h + 1))} className="h-12 w-12 rounded-xl bg-white/10 text-[20px] font-black disabled:opacity-40">+</button>
                </div>
                {err('hours')}
                <label className="block space-y-1">
                  <span className="text-[13px] font-bold text-slate-300">Ton nom d'artiste</span>
                  <input data-testid="studio-name" value={name} onChange={e => setName(e.target.value)} disabled={sending} maxLength={60} className={field} placeholder="Ex. : Nina" />
                </label>
                {err('name')}
                <label className="block space-y-1">
                  <span className="text-[13px] font-bold text-slate-300">Téléphone (pour te confirmer, facultatif)</span>
                  <input data-testid="studio-phone" type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} disabled={sending} className={field} placeholder="+32 4.. .. .. .." />
                </label>
                {err('phone')}
                <label className="block space-y-1">
                  <span className="text-[13px] font-bold text-slate-300">Un mot pour l'ingé (facultatif)</span>
                  <textarea data-testid="studio-message" value={message} onChange={e => setMessage(e.target.value)} disabled={sending} rows={3} maxLength={1000} className={`${field} py-2`} placeholder="Ex. : on refait le refrain, je viens avec un feat" />
                </label>
                {err('message')}
              </section>
            </div>

            <footer className="shrink-0 space-y-2 border-t border-white/10 px-5 py-4">
              {phase.k === 'sending' && (
                <div data-testid="studio-progress" aria-live="polite" className="space-y-1">
                  <div className="h-3 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${phase.pct}%` }} /></div>
                  <p className="text-[13px] text-slate-300">{phase.text}</p>
                </div>
              )}
              {phase.k === 'error' && <p role="alert" data-testid="studio-error" className="rounded-xl bg-red-500/20 px-3 py-2 text-[14px] font-semibold text-red-50">{phase.text}</p>}
              <button type="button" data-testid="studio-send-go" onClick={() => { void send(); }} disabled={sending || !signedIn}
                className="min-h-14 w-full rounded-2xl bg-amber-400 text-[16px] font-black text-black disabled:opacity-50">
                {sending ? 'Envoi en cours…' : phase.k === 'error' && phase.retry ? 'Réessayer' : 'Envoyer au studio'}
              </button>
              {!sending && <p className="text-center text-[12px] text-slate-500">{serviceLabel(service)} · {dayLabel(date)} · {hours} h — le studio confirme ensuite.</p>}
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

export default SendToStudioModal;
