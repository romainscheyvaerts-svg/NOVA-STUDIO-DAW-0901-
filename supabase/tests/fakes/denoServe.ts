/**
 * Remplace « https://deno.land/std@…/http/server.ts » dans les tests : serve()
 * ne lance aucun serveur, il garde le gestionnaire de la fonction pour que le
 * test l'appelle avec une vraie Request (fetch de Node).
 */
type Handler = (req: Request) => Response | Promise<Response>;
const handlers: Handler[] = [];

export function serve(handler: Handler): void { handlers.push(handler); }

/** Gestionnaire de la dernière fonction chargée. */
export function lastHandler(): Handler {
  const h = handlers[handlers.length - 1];
  if (!h) throw new Error('aucune fonction chargée');
  return h;
}
