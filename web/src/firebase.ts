import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  type HttpsCallableOptions,
} from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
const region = "us-central1";
export const functions = getFunctions(app, region);

if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export function callable<TReq, TRes>(name: string, options?: HttpsCallableOptions) {
  return httpsCallable<TReq, TRes>(functions, name, options);
}

/** Full URL Firebase may redirect to after the user clicks the email link (`handleCodeInApp: true`). */
export function getEmailLinkContinueUrl(): string {
  const explicit = import.meta.env.VITE_EMAIL_LINK_CONTINUE_URL?.trim();
  if (explicit) return explicit;
  if (typeof window === "undefined") return "";
  return new URL(import.meta.env.BASE_URL || "/", window.location.origin).href;
}

/** Auth emulator REST: list pending email-link codes (no auth; local dev only). */
export function getAuthEmulatorOobCodesListUrl(): string | null {
  if (!import.meta.env.DEV || import.meta.env.VITE_USE_EMULATOR !== "true") return null;
  const pid = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (!pid) return null;
  return `http://127.0.0.1:9099/emulator/v1/projects/${encodeURIComponent(pid)}/oobCodes`;
}

export function publicPlaylistUrl(publicToken: string): string {
  const pid = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === "true") {
    return `http://127.0.0.1:5001/${pid}/${region}/publicPlaylist?token=${encodeURIComponent(publicToken)}`;
  }
  return `https://${region}-${pid}.cloudfunctions.net/publicPlaylist?token=${encodeURIComponent(publicToken)}`;
}
