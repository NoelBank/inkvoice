// Injectable plan-feature policy. OSS ships no plans, so the default is a
// pass-through: plugins that declare `feature` behave as if ungated. An
// overlay (Inkvoice Cloud) installs its own policy at boot via
// setPluginFeatureGate, mapping a declared feature to plan middleware. OSS
// never imports overlay code.

import type { Context, Next } from "hono";

export type FeatureGateMiddleware = (c: Context, next: Next) => Promise<void | Response>;
export type PluginFeatureGate = (feature: string) => FeatureGateMiddleware;

let featureGate: PluginFeatureGate | null = null;

export function setPluginFeatureGate(gate: PluginFeatureGate | null): void {
  featureGate = gate;
}

export function getPluginFeatureGate(): PluginFeatureGate | null {
  return featureGate;
}
