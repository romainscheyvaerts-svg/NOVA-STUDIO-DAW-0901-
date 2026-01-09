
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // 1. Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const fileId = url.searchParams.get('id')

    if (!fileId) {
      throw new Error('Missing file ID')
    }

    const apiKey = Deno.env.get('GOOGLE_API_KEY')
    let driveUrl = ''

    if (apiKey) {
        // Method A: Official API (Best, avoids redirects and virus warnings)
        driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`
    } else {
        // Method B: Public Export Link (Fallback)
        driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`
    }

    console.log(`[Proxy] Fetching: ${driveUrl}`)

    const driveResponse = await fetch(driveUrl)

    if (!driveResponse.ok) {
        console.error(`[Proxy] Google Error: ${driveResponse.status}`)
        return new Response(`Google Drive Error: ${driveResponse.statusText}`, { 
            status: driveResponse.status,
            headers: corsHeaders 
        })
    }

    const newHeaders = new Headers(driveResponse.headers)
    newHeaders.set('Access-Control-Allow-Origin', '*')
    newHeaders.set('Cache-Control', 'public, max-age=3600')
    
    newHeaders.delete('x-frame-options')
    newHeaders.delete('content-security-policy')
    
    // Force suitable Content-Type if generic
    const contentType = newHeaders.get('Content-Type')
    if (!contentType || contentType === 'application/octet-stream') {
        // Default to MP3/MPEG if unknown, though client decoding usually sniffs header
        newHeaders.set('Content-Type', 'audio/mpeg')
    }

    return new Response(driveResponse.body, {
      status: driveResponse.status,
      headers: newHeaders,
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
