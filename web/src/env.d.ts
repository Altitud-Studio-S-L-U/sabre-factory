interface ImportMetaEnv {
  /** Content digest of the console build inputs (see scripts/build-id.mjs); absent in tests and dev. */
  readonly VITE_SABRE_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
