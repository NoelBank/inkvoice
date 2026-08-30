import { Hono } from "hono";
import { registerBackendPlugin } from "../registry";
import { timeTrackerMigrations } from "./migrations";

// Minimal registration: routes and the full plugin header land with the
// route-mounting task; this exists so the barrel import resolves and the
// plugin's migrations run.
registerBackendPlugin({
  id: "time-tracker",
  routes: new Hono(),
  migrations: timeTrackerMigrations,
  defaultEnabled: true,
});
