
import { User } from "../types";
import { supabase, isSupabaseConfigured, catalogSupabase } from "./supabase";
import { supabaseManager } from "./SupabaseManager";
import { authServiceMessage } from "../utils/authStatus";
import { friendlyAuthError } from "../utils/desktopAccess";
import { signUpMakeMusic, sendMakeMusicPasswordReset } from "./makeMusicSignup";

/** Erreur de connexion : message clair si le SERVICE est restreint / injoignable (402, 5xx, DNS). */
const authMessage = (error: any, fallback?: string) => authServiceMessage(error) || error?.message || fallback || "Erreur de connexion";

const DELAY_MS = 1500; // Pour le mode simulation

class AuthService {
  private currentUser: User | null = null;

  constructor() {
    this.checkSession();
  }

  private async checkSession() {
    if (isSupabaseConfigured() && supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session?.user) {
            this.currentUser = this.mapSupabaseUser(data.session.user);
        }
    } else {
        // Fallback Simulation : Vérification LocalStorage (Persistant) PUIS SessionStorage (Temporaire)
        let saved = localStorage.getItem('nova_user');
        
        if (!saved) {
            saved = sessionStorage.getItem('nova_user');
        }

        if (saved) {
            try {
                this.currentUser = JSON.parse(saved);
            } catch (e) {
                this.currentUser = null;
            }
        }
    }
  }

  public getUser(): User | null {
    return this.currentUser;
  }

  private mapSupabaseUser(sbUser: any): User {
      return {
          id: sbUser.id,
          email: sbUser.email || '',
          username: sbUser.user_metadata?.username || sbUser.email?.split('@')[0] || 'User',
          isVerified: !!sbUser.email_confirmed_at,
          plan: 'PRO' // Par défaut pour la démo
      };
  }

  /**
   * Inscription : crée le compte MAKE MUSIC (celui de studiomakemusic.com : paiements, collaboration,
   * séances en ligne, appli Windows), avec les règles du site (services/makeMusicSignup). Avant le
   * 16/10/2026, elle créait un compte de l'ancien projet, inconnu de tout le reste.
   * `needsConfirm` : l'e-mail de confirmation est parti (le compte s'ouvre en cliquant le lien).
   */
  public async register(email: string, password: string, username: string, opts: { desktop?: boolean } = {}): Promise<{ success: boolean; message?: string; needsConfirm?: boolean; makeMusicOnly?: boolean }> {
    try {
        const r = await signUpMakeMusic({ name: username, email, password }, opts);
        if (r.status === 'signed_in') return { success: true, makeMusicOnly: true };
        return { success: true, needsConfirm: true, message: "Vérifie tes e-mails pour confirmer ton compte." };
    } catch (e: any) {
        return { success: false, message: e?.message || "Création du compte impossible : réessaie dans un instant." };
    }
  }

  /**
   * Vérification Code (Uniquement pour Simulation)
   * En mode Supabase, la vérification se fait par lien cliqué dans l'email.
   */
  public async verifyEmail(code: string): Promise<{ success: boolean; user?: User; message?: string }> {
    if (isSupabaseConfigured()) {
        return { success: false, message: "Veuillez cliquer sur le lien reçu par email." };
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        const pendingStr = sessionStorage.getItem('nova_pending_registration');
        const validCode = sessionStorage.getItem('nova_verification_code');
        if (!pendingStr || !validCode) return resolve({ success: false, message: "Session expirée." });
        if (code !== validCode) return resolve({ success: false, message: "Code invalide." });

        const newUser: User = { ...JSON.parse(pendingStr), isVerified: true };
        this.currentUser = newUser;
        
        // Par défaut lors de la vérification, on stocke en session pour sécurité
        sessionStorage.setItem('nova_user', JSON.stringify(newUser));
        
        sessionStorage.removeItem('nova_pending_registration');
        sessionStorage.removeItem('nova_verification_code');
        resolve({ success: true, user: newUser });
      }, DELAY_MS);
    });
  }

  /**
   * Connexion avec option "Se souvenir de moi"
   */
  public async login(email: string, password: string, rememberMe: boolean = false): Promise<{ success: boolean; user?: User; message?: string; makeMusicOnly?: boolean; needsConfirm?: boolean }> {
    // --- MODE RÉEL ---
    if (isSupabaseConfigured() && supabase) {
        // Une seule connexion pour tout NOVA : les mêmes identifiants (tapés par la personne)
        // ouvrent aussi son compte Make Music (paiements, collaboration, séances en ligne), celui
        // de studiomakemusic.com. Aucun jeton n'est copié d'un projet à l'autre.
        let mmError: any = null;
        const makeMusic = (async () => {
            try {
                const r = await catalogSupabase.auth.signInWithPassword({ email: email.trim(), password });
                mmError = r.error || null;
                return !r.error && !!r.data?.user;
            } catch (e) { mmError = e; return false; }
        })();
        // Compte Make Music créé dans NOVA ou sur le site, lien de confirmation pas encore cliqué :
        // on le dit (avant : « Invalid login credentials », en anglais).
        const notConfirmed = () => /not confirmed/i.test(String(mmError?.message || '')) || mmError?.code === 'email_not_confirmed';
        const failure = (e: any) => notConfirmed()
            ? { success: false, needsConfirm: true, message: "Ton e-mail n'est pas encore confirmé : clique sur le lien reçu (regarde aussi dans les spams), puis reconnecte-toi." }
            : { success: false, message: authServiceMessage(e) || friendlyAuthError(e) || authMessage(e) };
        let data: any, error: any;
        try {
            ({ data, error } = await supabase.auth.signInWithPassword({ email, password }));
        } catch (e: any) {
            if (await makeMusic) return { success: true, makeMusicOnly: true };
            return failure(e);
        }
        if (error) {
            // Compte Make Music seulement (le cas courant : compte créé sur studiomakemusic.com).
            if (await makeMusic) return { success: true, makeMusicOnly: true };
            return failure(error);
        }
        await makeMusic;

        if (data.user) {
            this.currentUser = this.mapSupabaseUser(data.user);
            // Note: Supabase gère sa propre persistance interne via LocalStorage par défaut
            return { success: true, user: this.currentUser };
        }

        // Supabase repond sans erreur mais sans utilisateur (email non confirme,
        // reponse inattendue...) : on NE retombe PAS sur le mode simulation, qui
        // accorderait un compte PRO a n'importe quel email de plus de 6 caracteres.
        return { success: false, message: "Connexion impossible. Vérifiez vos identifiants ou confirmez votre email." };
    }

    // --- MODE SIMULATION (uniquement si Supabase n'est pas configuré) ---
    return new Promise((resolve) => {
      setTimeout(() => {
        if (password.length < 6) return resolve({ success: false, message: "Mot de passe incorrect." });
        
        const mockUser: User = { id: 'usr-demo', email, username: email.split('@')[0], isVerified: true, plan: 'PRO' };
        this.currentUser = mockUser;
        
        // Gestion de la persistance selon le choix utilisateur
        if (rememberMe) {
            localStorage.setItem('nova_user', JSON.stringify(mockUser));
            sessionStorage.removeItem('nova_user'); // Nettoyage croisé
        } else {
            sessionStorage.setItem('nova_user', JSON.stringify(mockUser));
            localStorage.removeItem('nova_user'); // Nettoyage croisé
        }
        
        resolve({ success: true, user: mockUser });
      }, DELAY_MS);
    });
  }

  /**
   * Connexion en tant qu'Invité (Pas de persistence, pas de Backend)
   */
  public async loginAsGuest(): Promise<User> {
      // Simule un petit délai pour l'expérience utilisateur
      await new Promise(resolve => setTimeout(resolve, 600));
      
      const guestUser: User = {
          id: `guest-${Date.now()}`,
          email: '',
          username: 'Guest Producer',
          isVerified: true,
          plan: 'FREE'
      };
      
      this.currentUser = guestUser;
      // On ne sauvegarde PAS dans le localStorage pour éviter la reconnexion auto
      return guestUser;
  }

  public async logout() {
    if (isSupabaseConfigured() && supabase) {
        await supabase.auth.signOut();
    }
    this.currentUser = null;
    
    // Nettoyage complet
    localStorage.removeItem('nova_user');
    sessionStorage.removeItem('nova_user');
    
    window.location.reload();
  }

  /**
   * Envoi lien de récupération
   */
  public async sendPasswordReset(email: string): Promise<{ success: boolean; message?: string }> {
    if (isSupabaseConfigured()) {
        // Le compte peut être Make Music (le cas courant) ou de l'ancien projet : le lien part des deux
        // (chacun ne l'envoie qu'à un e-mail qu'il connaît). Réussi si l'un des deux a accepté.
        const [mm, old] = await Promise.allSettled([
            sendMakeMusicPasswordReset(email),
            supabaseManager.resetPasswordForEmail(email),
        ]);
        if (mm.status === 'fulfilled' || old.status === 'fulfilled') return { success: true, message: "Lien envoyé : regarde tes e-mails (et les spams)." };
        const e: any = mm.status === 'rejected' ? mm.reason : (old as PromiseRejectedResult).reason;
        return { success: false, message: e?.message || authMessage(e, "Envoi impossible : réessaie dans un instant.") };
    }

    // Mode Simulation
    return new Promise((resolve) => {
      setTimeout(() => {
        console.log(`📧 [SIMULATION] Envoi lien reset password à ${email}`);
        resolve({ success: true, message: "Email simulé envoyé (Vérifiez la console)." });
      }, DELAY_MS);
    });
  }
}

export const authService = new AuthService();
