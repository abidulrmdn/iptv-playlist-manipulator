/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_USE_EMULATOR?: string;
  /** Optional. If unset, email-link sign-in uses the current origin (see `getEmailLinkContinueUrl`). */
  readonly VITE_EMAIL_LINK_CONTINUE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
