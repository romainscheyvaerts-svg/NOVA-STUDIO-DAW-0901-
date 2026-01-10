
// @ts-ignore
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
// @ts-ignore
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const apiKey = Deno.env.get('GOOGLE_API_KEY')
    const folderId = Deno.env.get('GOOGLE_DRIVE_FOLDER_ID') // Optionnel: pour limiter le scan

    if (!apiKey) {
        throw new Error("GOOGLE_API_KEY manquante");
    }

    // 1. Lister les fichiers audio depuis Google Drive API
    // On cherche les fichiers audio (mp3, wav) et les archives (zip/rar) qui ne sont pas dans la corbeille
    let query = "trashed=false and (mimeType contains 'audio/' or mimeType contains 'zip' or mimeType contains 'rar' or name contains '.mp3' or name contains '.wav')";
    
    if (folderId) {
        query += ` and '${folderId}' in parents`;
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&key=${apiKey}&fields=files(id,name,mimeType)&pageSize=100`;
    
    const driveRes = await fetch(driveUrl);
    if (!driveRes.ok) {
        const txt = await driveRes.text();
        throw new Error(`Google Drive API Error: ${txt}`);
    }

    const driveData = await driveRes.json();
    const files = driveData.files || [];

    // 2. Récupérer les fichiers déjà connus (Pending + Instruments)
    const { data: existingPending } = await supabaseClient
        .from('pending_uploads')
        .select('filename');
    
    // On pourrait aussi vérifier dans la table 'instruments' pour éviter les doublons globaux
    // mais ici on se concentre sur la boite de réception.

    const existingFilenames = new Set(existingPending?.map((p: any) => p.filename) || []);

    // 3. Filtrer les nouveaux fichiers
    const newFiles = files.filter((f: any) => !existingFilenames.has(f.name));
    
    if (newFiles.length === 0) {
        return new Response(JSON.stringify({ message: "Aucun nouveau fichier", addedCount: 0 }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });
    }

    // 4. Insérer dans pending_uploads
    const rowsToInsert = newFiles.map((f: any) => ({
        filename: f.name,
        // On construit l'URL de téléchargement direct (compatible avec notre proxy)
        download_url: `https://drive.google.com/file/d/${f.id}/view`,
        is_processed: false
    }));

    const { error: insertError } = await supabaseClient
        .from('pending_uploads')
        .insert(rowsToInsert);

    if (insertError) throw insertError;

    return new Response(JSON.stringify({ 
        message: "Synchronisation réussie", 
        addedCount: rowsToInsert.length 
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
