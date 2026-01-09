// @ts-ignore
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
// @ts-ignore
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'
// @ts-ignore
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Fix TypeScript error: Cannot find name 'Deno'
declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Edge Function 'create-checkout-session' chargée.")

serve(async (req: any) => {
  // 1. Gérer les requêtes CORS Preflight (OPTIONS)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 2. Vérifier la clé Stripe
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) {
      throw new Error('STRIPE_SECRET_KEY non configurée sur le serveur.')
    }

    // 3. Initialiser Stripe
    const stripe = new Stripe(stripeKey, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // 4. Lire le corps de la requête
    const { instrumentId, instrumentName, priceType, amount } = await req.json()

    if (!instrumentId || !amount) {
        throw new Error("Données manquantes (instrumentId ou amount).")
    }

    // 5. Préparer les données
    const origin = req.headers.get('origin') || 'http://localhost:5173'
    const unitAmount = Math.round(parseFloat(amount) * 100) // Conversion en centimes
    const productName = instrumentName ? `${instrumentName} (${priceType})` : `Instrument #${instrumentId} (${priceType})`

    console.log(`Création session pour: ${productName} à ${amount}$`)

    // 6. Créer la session Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: productName,
              description: `Licence ${priceType} - Nova DAW`,
              metadata: { instrument_id: instrumentId, license_type: priceType }
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${origin}/?payment_success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?payment_canceled=true`,
    })

    // 7. Retourner l'URL
    return new Response(
      JSON.stringify({ url: session.url }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    )

  } catch (error: any) {
    console.error("Erreur Edge Function:", error.message)
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    )
  }
})