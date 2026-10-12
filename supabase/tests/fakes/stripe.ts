/**
 * Faux SDK Stripe (« https://esm.sh/stripe@… » dans les tests) : sessions de
 * paiement, clients, abonnements et portail en mémoire. Aucun appel réseau.
 */
export interface FakeStripeState {
  sessions: Record<string, any>;
  subscriptions: Record<string, any>;
  customers: { id: string; email: string }[];
  created: any[];
}
export const stripeState: FakeStripeState = { sessions: {}, subscriptions: {}, customers: [], created: [] };
export function resetStripe() {
  stripeState.sessions = {}; stripeState.subscriptions = {}; stripeState.customers = []; stripeState.created = [];
}

let n = 0;
export default class Stripe {
  constructor(_key: string, _opts?: unknown) {}
  customers = {
    list: async ({ email }: { email: string }) => ({ data: stripeState.customers.filter(c => c.email === email) }),
    create: async ({ email }: { email: string }) => { const c = { id: `cus_${++n}`, email }; stripeState.customers.push(c); return c; },
  };
  checkout = {
    sessions: {
      create: async (params: any) => {
        const id = `cs_test_${++n}abc`;
        const s = { id, url: `https://checkout.stripe.test/${id}`, ...params, status: 'open', payment_status: 'unpaid' };
        stripeState.sessions[id] = s;
        stripeState.created.push(params);
        return s;
      },
      retrieve: async (id: string) => {
        const s = stripeState.sessions[id];
        if (!s) throw new Error('No such checkout.session');
        return s;
      },
    },
  };
  subscriptions = {
    retrieve: async (id: string) => stripeState.subscriptions[id],
    list: async ({ customer }: { customer: string }) => ({ data: Object.values(stripeState.subscriptions).filter((s: any) => s.customer === customer) }),
  };
  billingPortal = { sessions: { create: async ({ return_url }: any) => ({ url: `https://billing.stripe.test/p?r=${encodeURIComponent(return_url)}` }) } };
}
export declare namespace Stripe { type Subscription = any }
