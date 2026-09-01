// Official OSS plugins. Side-effect imports register each plugin at module
// load. app.ts imports this barrel so the registry is populated before
// runPluginMigrations() and route mounting.

import "./time-tracker";
