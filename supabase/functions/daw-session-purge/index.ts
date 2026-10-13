// Ménage des projets en ligne Nova (grille du 14/10/2026 : gratuit = 1 projet gardé 7 jours).
//
// PRÉVU, PAS LANCÉ : aucune programmation n'est créée par les migrations. Pour la lancer,
// voir D:\1 WORK\CONTENU\nova-tarifs\DEPLOIEMENT.md (étape « ménage »), avec le GO de Romain.
//
// Sécurité : clé obligatoire (en-tête x-purge-key = secret NOVA_PURGE_KEY), sinon 401.
// Par défaut, SIMULATION (rien n'est effacé) : il faut envoyer { "confirm": "purge" }.
//
//  1. Projet expiré (expires_at passé) :
//       - propriétaire Nova Pro (payé ou offert) / admin → gardé, plus d'expiration ;
//       - sinon → fichiers audio + ligne supprimés.
//  2. Projet « sans expiration » dont le propriétaire n'a plus Nova Pro → 7 jours de grâce.
//  3. Projet qui expire dans 2 jours ou moins → marqué « averti » (expiry_warned_at) : le DAW
//     affiche l'avertissement (aucun e-mail n'est envoyé).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { TARIFS, isProOrAdmin, jours } from "../_shared/novaTarifs.ts";

const BUCKET = "daw-sessions";
const LOT = 50; // projets traités par passage (le suivant reprend)

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function removeSessionFiles(id: string) {
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(id, { limit: 1000 });
    if (error) throw new Error(error.message);
    if (!data?.length) return;
    const paths = data.map((o: any) => `${id}/${o.name}`);
    for (let i = 0; i < paths.length; i += 100) {
      const { error: e } = await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      if (e) throw new Error(e.message);
    }
    if (data.length < 1000) return;
  }
}

export async function purge(dryRun: boolean, now = Date.now()) {
  const bilan = { simulation: dryRun, supprimes: 0, gardes_pro: 0, grace_fin_pro: 0, avertis: 0, erreurs: 0, details: [] as string[] };
  const statut = new Map<string, boolean>();
  const illimite = async (owner: string | null) => {
    if (!owner) return false;
    if (!statut.has(owner)) statut.set(owner, await isProOrAdmin(supabase, owner));
    return statut.get(owner)!;
  };
  const nowIso = new Date(now).toISOString();

  // 1) Expirés.
  const { data: echus, error } = await supabase.from("daw_sessions").select("id, owner_id, name, expires_at")
    .lt("expires_at", nowIso).order("expires_at", { ascending: true }).limit(LOT);
  if (error) throw new Error(error.message);
  for (const s of (echus || []) as any[]) {
    if (!s.expires_at) continue;
    try {
      if (await illimite(s.owner_id)) {
        if (!dryRun) await supabase.from("daw_sessions").update({ expires_at: null }).eq("id", s.id);
        bilan.gardes_pro++;
        continue;
      }
      bilan.details.push(`supprimé ${s.id} (${s.name})`);
      if (!dryRun) {
        await removeSessionFiles(s.id);
        await supabase.from("daw_sessions").delete().eq("id", s.id); // cascade : membres + journal collab
      }
      bilan.supprimes++;
    } catch (e) {
      bilan.erreurs++;
      console.error("[daw-session-purge]", s.id, (e as Error).message);
    }
  }

  // 2) Sans expiration mais propriétaire plus Pro → 7 jours de grâce.
  const { data: sansFin } = await supabase.from("daw_sessions").select("id, owner_id, expires_at").is("expires_at", null).limit(500);
  const grace = new Date(now + jours(TARIFS.projet_gratuit_jours)).toISOString();
  for (const s of (sansFin || []) as any[]) {
    if (s.expires_at || !s.owner_id) continue; // sans propriétaire : séances anciennes, laissées au ménage des 180 jours
    if (await illimite(s.owner_id)) continue;
    if (!dryRun) await supabase.from("daw_sessions").update({ expires_at: grace }).eq("id", s.id);
    bilan.grace_fin_pro++;
  }

  // 3) Avertissement (affiché par le DAW) : expire dans 2 jours ou moins.
  const bientot = new Date(now + jours(TARIFS.avertir_avant_jours)).toISOString();
  const { data: proches } = await supabase.from("daw_sessions").select("id, expires_at, expiry_warned_at")
    .gt("expires_at", nowIso).lt("expires_at", bientot).limit(500);
  for (const s of (proches || []) as any[]) {
    if (s.expiry_warned_at) continue;
    if (!dryRun) await supabase.from("daw_sessions").update({ expiry_warned_at: nowIso }).eq("id", s.id);
    bilan.avertis++;
  }
  return bilan;
}

serve(async (req) => {
  const headers = { "Content-Type": "application/json" };
  const key = Deno.env.get("NOVA_PURGE_KEY") || "";
  if (!key || req.headers.get("x-purge-key") !== key) {
    return new Response(JSON.stringify({ error: "Clé de ménage manquante" }), { status: 401, headers });
  }
  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* corps vide */ }
    const bilan = await purge(body?.confirm !== "purge");
    console.log("[daw-session-purge]", JSON.stringify({ ...bilan, details: bilan.details.length }));
    return new Response(JSON.stringify(bilan), { headers });
  } catch (e) {
    console.error("[daw-session-purge]", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
  }
});
