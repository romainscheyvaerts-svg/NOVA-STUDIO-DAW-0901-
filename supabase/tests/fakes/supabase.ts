/**
 * Faux client supabase-js (côté serveur) pour tester les fonctions Edge sans
 * réseau ni base réelle : tables en mémoire, stockage en mémoire, jetons connus.
 * Substitué à « https://esm.sh/@supabase/supabase-js@… » par l'alias de
 * vitest.config.ts. Seules les méthodes utilisées par daw-session et
 * nova-billing sont imitées.
 */

export interface FakeDb {
  tables: Record<string, any[]>;
  storage: Record<string, Map<string, { size: number; created_at: string }>>;
  /** jeton (Bearer) → utilisateur */
  users: Record<string, { id: string; email?: string }>;
  rpc: Record<string, (args: any) => any>;
  seq: Record<string, number>;
  /** Journal des écritures (table, type) : vérifie qu'une action n'écrit rien. */
  writes: { table: string; op: string; row?: any }[];
}

export function createFakeDb(): FakeDb {
  return { tables: {}, storage: {}, users: {}, rpc: {}, seq: {}, writes: [] };
}

let current: FakeDb = createFakeDb();
export function setCurrentDb(db: FakeDb) { current = db; }

/** Clés naturelles pour upsert (comme les clés primaires des migrations du site). */
const UPSERT_KEYS: Record<string, string[]> = {
  daw_session_members: ['session_id', 'member_key'],
  nova_subscriptions: ['stripe_subscription_id'],
  nova_purchases: ['checkout_session_id'],
  daw_session_invites: ['code'],
};
const UNIQUE: Record<string, string[][]> = {
  daw_session_invites: [['code']],
  nova_export_uses: [['user_id', 'project_key']],
  studio_booking_requests: [['package_id']],
  // 1.5.1 (lots 3 et 9) : invite_copie_151.sql.
  daw_session_forks: [['token_hash']],
  daw_session_fork_copies: [['fork_id', 'user_id']],
  nova_public_tracks: [['session_id']],
};

type Filter = (row: any) => boolean;

class Query implements PromiseLike<any> {
  private filters: Filter[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private countMode = false;
  private headOnly = false;
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: any = null;
  private returning = false;

  constructor(private db: FakeDb, private table: string) {}

  private rows(): any[] { return (this.db.tables[this.table] ||= []); }

  select(_cols?: string, opts?: { count?: 'exact'; head?: boolean }) {
    if (this.op !== 'select') this.returning = true;
    this.countMode = opts?.count === 'exact';
    this.headOnly = !!opts?.head;
    return this;
  }
  insert(v: any) { this.op = 'insert'; this.payload = v; return this; }
  upsert(v: any) { this.op = 'upsert'; this.payload = v; return this; }
  update(v: any) { this.op = 'update'; this.payload = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c: string, v: any) { this.filters.push(r => r[c] === v); return this; }
  in(c: string, v: any[]) { this.filters.push(r => v.includes(r[c])); return this; }
  is(c: string, v: any) { this.filters.push(r => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  gt(c: string, v: any) { this.filters.push(r => r[c] > v); return this; }
  gte(c: string, v: any) { this.filters.push(r => r[c] >= v); return this; }
  lt(c: string, v: any) { this.filters.push(r => r[c] < v); return this; }
  lte(c: string, v: any) { this.filters.push(r => r[c] <= v); return this; }
  is(c: string, v: any) { this.filters.push(r => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }

  private matching(): any[] {
    let out = this.rows().filter(r => this.filters.every(f => f(r)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    return out;
  }

  private withDefaults(row: any): any {
    const r = { ...row };
    if (this.table === 'daw_session_ops') {
      this.db.seq[this.table] = (this.db.seq[this.table] || 0) + 1;
      r.seq = this.db.seq[this.table];
    }
    if (this.table === 'nova_export_uses' && r.id === undefined) {
      this.db.seq[this.table] = (this.db.seq[this.table] || 0) + 1;
      r.id = this.db.seq[this.table];
    }
    if (r.created_at === undefined) r.created_at = new Date().toISOString();
    if (this.table === 'daw_sessions') {
      r.version ??= 0; r.manifest ??= null; r.total_bytes ??= 0; r.updated_at ??= new Date().toISOString();
    }
    return r;
  }

  private duplicate(row: any): boolean {
    return (UNIQUE[this.table] || []).some(cols => this.rows().some(r => cols.every(c => r[c] === row[c])));
  }

  private exec(): { data: any; error: any; count: number | null } {
    const list = (v: any) => (Array.isArray(v) ? v : [v]);
    if (this.op === 'select') {
      let rows = this.matching();
      const count = this.countMode ? rows.length : null;
      if (this.max !== null) rows = rows.slice(0, this.max);
      return { data: this.headOnly ? null : structuredClone(rows), error: null, count };
    }
    if (this.op === 'insert') {
      const out: any[] = [];
      for (const row of list(this.payload)) {
        if (this.duplicate(row)) return { data: null, error: { message: 'duplicate key value violates unique constraint' }, count: null };
        const r = this.withDefaults(row);
        this.rows().push(r);
        this.db.writes.push({ table: this.table, op: 'insert', row: r });
        out.push(r);
      }
      return { data: this.returning ? structuredClone(out) : null, error: null, count: null };
    }
    if (this.op === 'upsert') {
      const keys = UPSERT_KEYS[this.table] || ['id'];
      const out: any[] = [];
      for (const row of list(this.payload)) {
        const existing = this.rows().find(r => keys.every(k => r[k] === row[k]));
        if (existing) { Object.assign(existing, row); out.push(existing); }
        else { const r = this.withDefaults(row); this.rows().push(r); out.push(r); }
        this.db.writes.push({ table: this.table, op: 'upsert', row });
      }
      return { data: this.returning ? structuredClone(out) : null, error: null, count: null };
    }
    if (this.op === 'update') {
      const rows = this.matching();
      for (const r of rows) Object.assign(r, this.payload);
      this.db.writes.push({ table: this.table, op: 'update', row: this.payload });
      return { data: this.returning ? structuredClone(rows) : null, error: null, count: null };
    }
    const gone = new Set(this.matching());
    this.db.tables[this.table] = this.rows().filter(r => !gone.has(r));
    this.db.writes.push({ table: this.table, op: 'delete' });
    return { data: null, error: null, count: null };
  }

  async maybeSingle() {
    const r = this.exec();
    if (r.error) return r;
    const rows = Array.isArray(r.data) ? r.data : [];
    return { data: rows[0] ?? null, error: null };
  }
  async single() {
    const r = this.exec();
    if (r.error) return r;
    const rows = Array.isArray(r.data) ? r.data : [];
    return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
  }
  then<A = any, B = never>(ok?: ((v: any) => A | PromiseLike<A>) | null, ko?: ((e: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.exec()).then(ok, ko);
  }
}

export function createClient(_url: string, _key: string): any {
  // Le client est créé au chargement du module de la fonction : il lit toujours la base COURANTE.
  const db = () => current;
  return {
    from: (table: string) => new Query(db(), table),
    rpc: async (name: string, args: any) => {
      const fn = db().rpc[name];
      if (!fn) return { data: null, error: { message: `fonction ${name} inconnue` } };
      return { data: await fn(args), error: null };
    },
    auth: {
      getUser: async (token: string) => ({ data: { user: db().users[token] ?? null }, error: db().users[token] ? null : { message: 'invalid JWT' } }),
    },
    storage: {
      from: (bucket: string) => {
        const m = () => (db().storage[bucket] ||= new Map());
        return {
          list: async (prefix: string, opts?: { limit?: number; offset?: number }) => {
            const p = `${prefix}/`;
            const all = [...m().entries()].filter(([k]) => k.startsWith(p))
              .map(([k, v]) => ({ name: k.slice(p.length), metadata: { size: v.size }, created_at: v.created_at }));
            const off = opts?.offset || 0;
            return { data: all.slice(off, off + (opts?.limit ?? 100)), error: null };
          },
          remove: async (paths: string[]) => { paths.forEach(p => m().delete(p)); return { data: null, error: null }; },
          createSignedUploadUrl: async (path: string) => ({ data: { path, token: `tok-${path}` }, error: null }),
          createSignedUrls: async (paths: string[]) => ({ data: paths.map(p => ({ signedUrl: `https://signed.test/${p}` })), error: null }),
        };
      },
    },
  };
}
