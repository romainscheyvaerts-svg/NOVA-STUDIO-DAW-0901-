
import { User } from "../types";
import { supabase, isSupabaseConfigured } from "./supabase";
import { supabaseManager } from "./SupabaseManager";

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
   * Inscription (Réelle ou Simulée)
   */
  public async register(email: string, password: string, username: string): Promise<{ success: boolean; message?: string }> {
    // --- MODE RÉEL (SUPABASE) ---
    if (isSupabaseConfigured() && supabase) {
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { username }
            }
        });

        if (error) {
            return { success: false, message: error.message };
        }

        // Si auto-confirm est OFF, l'utilisateur doit vérifier son email
        return { success: true, message: "Vérifiez vos emails pour confirmer." };
    }

    // --- MODE SIMULATION (LocalStorage) ---
    return new Promise((resolve) => {
      setTimeout(() => {
        if (email.includes('error')) {
          resolve({ success: false, message: "Cet email est déjà utilisé." });
          return;
        }
        const tempUser: User = { id: `usr-${Date.now()}`, email, username, isVerified: false, plan: 'FREE' };
        sessionStorage.setItem('nova_pending_registration', JSON.stringify(tempUser));
        sessionStorage.setItem('nova_verification_code', '123456');
        console.log(`📧 [SIMULATION] Envoi à ${email}: Code 123456`);
        resolve({ success: true });
      }, DELAY_MS);
    });
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
  public async login(email: string, password: string, rememberMe: boolean = false): Promise<{ success: boolean; user?: User; message?: string }> {
    // --- MODE RÉEL ---
    if (isSupabaseConfigured() && supabase) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return { success: false, message: error.message };
        
        if (data.user) {
            this.currentUser = this.mapSupabaseUser(data.user);
            // Note: Supabase gère sa propre persistance interne via LocalStorage par défaut
            return { success: true, user: this.currentUser };
        }
    }

    // --- MODE SIMULATION ---
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
        try {
            await supabaseManager.resetPasswordForEmail(email);
            return { success: true, message: "Lien envoyé. Vérifiez vos emails." };
        } catch (e: any) {
            return { success: false, message: e.message || "Erreur d'envoi." };
        }
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
