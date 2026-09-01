// App version for the backend. The frontend has its own copy at
// lib/version.ts reading the frontend package.json; this reads the backend's.
// The release process bumps all three package.json versions together, so the
// two stay in lockstep without extra wiring.
//
// Used to decide whether this install satisfies a plugin release's min_app.
import { version } from "../../package.json";

export const APP_VERSION: string = version;
