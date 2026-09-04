import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

// Input validation schema
const InvoiceItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive().max(1000),
  unitPrice: z.number().min(0).max(100000),
});

const InvoiceRequestSchema = z.object({
  invoiceNumber: z.string().min(1).max(50),
  date: z.string().min(1).max(20),
  dueDate: z.string().max(20).optional(),
  clientName: z.string().min(1).max(200),
  clientEmail: z.string().email().max(255),
  clientAddress: z.string().max(500).optional(),
  items: z.array(InvoiceItemSchema).min(1).max(50),
  notes: z.string().max(2000).optional(),
  sendEmail: z.boolean(),
  sessionType: z.string().max(100).optional(),
  hours: z.number().positive().max(100).optional(),
  totalAmount: z.number().min(0).max(1000000).optional(),
  orderId: z.string().max(100).optional(),
});

type InvoiceRequest = z.infer<typeof InvoiceRequestSchema>;

// Check if user has admin or superadmin role in database
async function isUserAdmin(supabase: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "superadmin"]);
  
  if (error) {
    console.error("[INVOICE] Error checking admin role:", error);
    return false;
  }
  
  return data && data.length > 0;
}

function generateInvoiceHtml(data: InvoiceRequest): string {
  const total = data.items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
  const formattedDate = new Date(data.date).toLocaleDateString('fr-BE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  const formattedDueDate = data.dueDate 
    ? new Date(data.dueDate).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  // Escape HTML to prevent XSS
  const escapeHtml = (str: string) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const itemsHtml = data.items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #333;">${escapeHtml(item.description)}</td>
      <td style="padding: 12px; border-bottom: 1px solid #333; text-align: center;">${item.quantity}</td>
      <td style="padding: 12px; border-bottom: 1px solid #333; text-align: right;">${item.unitPrice.toFixed(2)} €</td>
      <td style="padding: 12px; border-bottom: 1px solid #333; text-align: right;">${(item.quantity * item.unitPrice).toFixed(2)} €</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Facture ${escapeHtml(data.invoiceNumber)} - Make Music</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
    body { font-family: 'Inter', sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; padding: 40px; }
    .invoice-container { max-width: 800px; margin: 0 auto; background: #1a1a1a; border-radius: 16px; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; border-bottom: 2px solid #22d3ee; padding-bottom: 20px; }
    .logo { font-size: 28px; font-weight: 700; color: #22d3ee; }
    .invoice-title { text-align: right; }
    .invoice-title h1 { margin: 0; font-size: 32px; color: #22d3ee; }
    .invoice-title p { margin: 5px 0 0 0; color: #a1a1aa; }
    .addresses { display: flex; justify-content: space-between; margin-bottom: 40px; }
    .address-block { flex: 1; }
    .address-block h3 { color: #22d3ee; font-size: 14px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
    .address-block p { margin: 4px 0; color: #d4d4d8; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
    thead th { background: #22d3ee; color: #0a0a0a; padding: 12px; text-align: left; font-weight: 600; }
    thead th:nth-child(2), thead th:nth-child(3), thead th:nth-child(4) { text-align: center; }
    thead th:last-child { text-align: right; }
    .total-row { background: #262626; }
    .total-row td { padding: 16px 12px; font-weight: 700; font-size: 18px; }
    .notes { background: #262626; padding: 20px; border-radius: 8px; margin-top: 30px; }
    .notes h4 { margin: 0 0 10px 0; color: #22d3ee; }
    .notes p { margin: 0; color: #a1a1aa; font-size: 14px; }
    .footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #333; color: #71717a; font-size: 12px; }
    @media print {
      body { background: white; color: black; }
      .invoice-container { background: white; box-shadow: none; }
      .header { border-bottom-color: #22d3ee; }
      thead th { background: #22d3ee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="invoice-container">
    <div class="header">
      <div class="logo">MAKE MUSIC 🎵</div>
      <div class="invoice-title">
        <h1>FACTURE</h1>
        <p>N° ${escapeHtml(data.invoiceNumber)}</p>
        <p>Date : ${formattedDate}</p>
        ${formattedDueDate ? `<p>Échéance : ${formattedDueDate}</p>` : ''}
      </div>
    </div>

    <div class="addresses">
      <div class="address-block">
        <h3>Émetteur</h3>
        <p><strong>Make Music Studio</strong></p>
        <p>Rue du Sceptre 22</p>
        <p>1050 Ixelles, Bruxelles</p>
        <p>Belgique</p>
        <p>📧 prod.makemusic@gmail.com</p>
        <p>📞 +32 476 09 41 72</p>
      </div>
      <div class="address-block" style="text-align: right;">
        <h3>Client</h3>
        <p><strong>${escapeHtml(data.clientName)}</strong></p>
        <p>${escapeHtml(data.clientEmail)}</p>
        ${data.clientAddress ? `<p>${escapeHtml(data.clientAddress).replace(/\n/g, '<br>')}</p>` : ''}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 50%;">Description</th>
          <th style="width: 15%;">Quantité</th>
          <th style="width: 15%;">Prix unitaire</th>
          <th style="width: 20%;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
        <tr class="total-row">
          <td colspan="3" style="text-align: right; padding-right: 20px;">TOTAL TTC</td>
          <td style="text-align: right; color: #22d3ee;">${total.toFixed(2)} €</td>
        </tr>
      </tbody>
    </table>

    ${data.notes ? `
    <div class="notes">
      <h4>Notes</h4>
      <p>${escapeHtml(data.notes)}</p>
    </div>
    ` : ''}

    <div class="footer">
      <p>Make Music Studio - Studio d'enregistrement professionnel</p>
      <p>Merci pour votre confiance ! 🎵</p>
    </div>
  </div>
</body>
</html>
  `;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify authentication - only admin can generate invoices
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    console.log("[INVOICE] Auth header present:", !!authHeader);
    
    if (!authHeader) {
      console.error("[INVOICE] No authorization header");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace("Bearer ", "");
    console.log("[INVOICE] Token length:", token.length);

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    console.log("[INVOICE] Auth result - user:", user?.email, "error:", authError?.message);
    
    if (authError || !user) {
      console.error("[INVOICE] Auth error:", authError?.message);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if user is admin via database role check (accept both admin and superadmin)
    const hasAdminRole = await isUserAdmin(supabase, user.id);
    
    if (!hasAdminRole) {
      console.error("[INVOICE] Non-admin user attempted to generate invoice:", user.email, user.id);
      return new Response(
        JSON.stringify({ error: "Forbidden - Admin access required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    console.log("[INVOICE] User has admin role, proceeding...");

    // Parse and validate input
    const rawBody = await req.json();
    const validationResult = InvoiceRequestSchema.safeParse(rawBody);
    
    if (!validationResult.success) {
      console.error("[INVOICE] Validation error:", validationResult.error.errors);
      return new Response(
        JSON.stringify({ error: "Invalid request data", details: validationResult.error.errors }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = validationResult.data;
    
    console.log("[INVOICE] Generating invoice:", body.invoiceNumber, "by admin:", user.email);

    const invoiceHtml = generateInvoiceHtml(body);

    if (body.sendEmail && body.clientEmail) {
      console.log("[INVOICE] Sending invoice to:", body.clientEmail);
      
      const { error: emailError } = await resend.emails.send({
        from: "Make Music Studio <noreply@studiomakemusic.com>",
        to: [body.clientEmail],
        subject: `Facture ${body.invoiceNumber} - Make Music Studio`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #22d3ee;">Votre facture Make Music</h2>
            <p>Bonjour ${body.clientName},</p>
            <p>Veuillez trouver ci-dessous votre facture n° <strong>${body.invoiceNumber}</strong>.</p>
            <p>Montant total : <strong>${body.items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0).toFixed(2)} €</strong></p>
            <hr style="border: 1px solid #333; margin: 20px 0;">
            ${invoiceHtml}
            <hr style="border: 1px solid #333; margin: 20px 0;">
            <p style="color: #888; font-size: 12px;">
              Make Music Studio<br>
              Rue du Sceptre 22, 1050 Ixelles, Bruxelles<br>
              prod.makemusic@gmail.com | +32 476 09 41 72
            </p>
          </div>
        `,
      });

      if (emailError) {
        console.error("[INVOICE] Email error:", emailError);
        throw emailError;
      }

      console.log("[INVOICE] Email sent successfully");
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        invoiceHtml,
        invoiceNumber: body.invoiceNumber,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error("[INVOICE] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
